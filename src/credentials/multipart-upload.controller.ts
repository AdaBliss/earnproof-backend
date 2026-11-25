import {
  Controller,
  Post,
  UseGuards,
  BadRequestException,
  Logger,
  Req,
  Header,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiConsumes } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { RequiredRole } from '../common/decorators/required-role.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { MultipartUploadService, MultipartUploadResponse } from './multipart-upload.service';

/**
 * Multipart Upload Controller (v1)
 *
 * Handles multipart/form-data file uploads with streaming, type detection,
 * content inspection, and quarantine intake. All uploaded credentials are
 * automatically quarantined for review before release to normal processing.
 *
 * Authorization:
 * - Requires authentication (bearer token)
 * - Requires ADMIN role
 * - Rate limited to 10 requests/minute per user
 *
 * Uploads are scoped to the authenticated user's organization (tenant).
 */
@ApiTags('Credentials - Multipart Upload (v1)')
@ApiBearerAuth()
@Controller('api/v1/credentials/multipart')
export class MultipartUploadController {
  private readonly logger = new Logger(MultipartUploadController.name);

  constructor(private readonly multipartUploadService: MultipartUploadService) {}

  /**
   * Upload credential files for quarantine intake.
   *
   * POST /api/v1/credentials/multipart/upload
   *
   * Accepts multipart/form-data with credential files. Each file is:
   * 1. Streamed with size limits (32 KB per file, 256 KB total)
   * 2. Type-detected (JSON, binary)
   * 3. Content-inspected (format validation, scanner hooks)
   * 4. Quarantined with safe metadata (never raw credential)
   *
   * All files are independently processed; errors in one do not block others.
   * Temporary files are cleaned up after processing.
   *
   * @param session Authenticated user session
   * @param req Express request object (contains multipart stream)
   * @returns Array of quarantine records created
   *
   * @throws BadRequestException on invalid multipart, oversized files, or unsupported types
   * @throws PayloadTooLargeException if organization quarantine capacity exceeded
   * @throws UnauthorizedException if not authenticated
   * @throws ForbiddenException if not ADMIN role
   */
  @Post('upload')
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole(['ADMIN'])
  @Throttle({ default: { limit: 10, ttl: 60_000 } }) // 10 requests per minute
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload credential files for quarantine intake',
    description:
      'Uploads credential files with streaming limits, type detection, content inspection, ' +
      'and automatic quarantine intake. Each file is quarantined for review before release.',
  })
  @ApiResponse({
    status: 200,
    description: 'Files received and quarantined',
    schema: {
      type: 'object',
      properties: {
        quarantines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              filename: { type: 'string' },
              hash: { type: 'string' },
              quarantineId: { type: 'string' },
              state: { type: 'string' },
              reason: { type: 'string' },
              size: { type: 'number' },
            },
          },
        },
        summary: {
          type: 'object',
          properties: {
            uploaded: { type: 'number' },
            quarantined: { type: 'number' },
            errors: { type: 'number' },
            totalSize: { type: 'number' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid multipart data, unsupported file type, or parse error',
  })
  @ApiResponse({
    status: 413,
    description: 'File(s) exceed size limits or organization quarantine capacity exceeded',
  })
  @ApiResponse({
    status: 408,
    description: 'Multipart parse timeout exceeded (30 seconds)',
  })
  @ApiResponse({
    status: 401,
    description: 'Not authenticated',
  })
  @ApiResponse({
    status: 403,
    description: 'Not ADMIN role',
  })
  async uploadCredentials(
    @CurrentUser() session: AuthenticatedUser,
    @Req() req: any,
  ): Promise<MultipartUploadResponse> {
    // Validate user has organization context
    if (!session.organizationId) {
      throw new BadRequestException('User must have organization context');
    }

    // Validate content type is multipart/form-data
    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.includes('multipart/form-data')) {
      throw new BadRequestException(
        'Content-Type must be multipart/form-data',
      );
    }

    this.logger.log(
      `Upload request from user ${session.id}, org ${session.organizationId}`,
    );

    try {
      const response = await this.multipartUploadService.uploadAndQuarantine(
        req,
        contentType,
        session.organizationId,
        session.id,
      );

      this.logger.log(
        `Upload successful: ${response.summary.quarantined} quarantined, ${response.summary.errors} errors`,
      );

      return response;
    } catch (error) {
      this.logger.error(`Upload failed: ${error}`);
      throw error;
    }
  }
}

import {
  Injectable,
  BadRequestException,
  ConflictException,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import { readFile, unlink } from 'fs/promises';
import { CredentialQuarantine, CredentialQuarantineReasonCode } from '@prisma/client';
import { MultipartParserService, ParsedPart } from '../common/uploads/multipart-parser.service';
import { ContentInspectionService } from '../common/uploads/content-inspection.service';
import { CredentialQuarantineService } from './credential-quarantine.service';
import { PrismaService } from '../database/prisma.service';
import { createHash } from 'crypto';

/**
 * Multipart upload response item
 */
export interface UploadResultItem {
  filename: string;
  hash: string;
  quarantineId: string;
  state: string;
  reason: CredentialQuarantineReasonCode;
  size: number;
}

/**
 * Multipart upload response
 */
export interface MultipartUploadResponse {
  quarantines: UploadResultItem[];
  summary: {
    uploaded: number;
    quarantined: number;
    errors: number;
    totalSize: number;
  };
}

/**
 * Multipart Upload Service
 *
 * Orchestrates streaming multipart upload, content inspection, and
 * quarantine intake. Integrates parser, inspector, and quarantine service.
 */
@Injectable()
export class MultipartUploadService {
  private readonly logger = new Logger(MultipartUploadService.name);

  constructor(
    private readonly parser: MultipartParserService,
    private readonly inspector: ContentInspectionService,
    private readonly quarantineService: CredentialQuarantineService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Upload and quarantine multipart credentials.
   *
   * Orchestrates:
   * 1. Streaming multipart parse (with size/type detection)
   * 2. Content inspection (format validation, scanner hooks)
   * 3. Quarantine intake (deduplication, capacity check, audit)
   *
   * Each part is independently quarantined. Errors in one part do not
   * block others. All temporary files are cleaned up on completion.
   *
   * @param req Express request object
   * @param contentType Content-Type header value
   * @param organizationId Organization (tenant) ID
   * @param importedByUserId User performing the upload
   * @returns Upload response with quarantine records and summary
   * @throws BadRequestException on invalid input
   * @throws PayloadTooLargeException on size violations
   */
  async uploadAndQuarantine(
    req: any,
    contentType: string,
    organizationId: string,
    importedByUserId: string,
  ): Promise<MultipartUploadResponse> {
    let parseResult = null;

    try {
      // 1. Parse multipart stream
      this.logger.log(
        `Starting multipart upload for org: ${organizationId}, user: ${importedByUserId}`,
      );

      parseResult = await this.parser.parseMultipart(req, contentType);

      this.logger.log(
        `Parsed ${parseResult.parts.length} parts, total size: ${parseResult.totalSize} bytes`,
      );

      // 2. Process each part: inspect → extract metadata → quarantine
      const quarantines: UploadResultItem[] = [];
      const errors: Array<{ part: number; error: string }> = [];

      for (let i = 0; i < parseResult.parts.length; i++) {
        const part = parseResult.parts[i];

        try {
          const result = await this.processAndQuarantinePart(
            part,
            organizationId,
            importedByUserId,
          );

          quarantines.push(result);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `Failed to process part ${i + 1}: ${errorMsg}`,
          );
          errors.push({
            part: i + 1,
            error: errorMsg,
          });
        }
      }

      // 3. Return response
      const response: MultipartUploadResponse = {
        quarantines,
        summary: {
          uploaded: parseResult.parts.length,
          quarantined: quarantines.length,
          errors: errors.length,
          totalSize: parseResult.totalSize,
        },
      };

      this.logger.log(
        `Upload completed: ${quarantines.length} quarantined, ${errors.length} errors`,
      );

      return response;
    } catch (error) {
      this.logger.error(`Upload failed: ${error}`);
      throw error;
    } finally {
      // Always cleanup temporary files
      if (parseResult) {
        await this.parser.cleanupParseResult(parseResult).catch((error) => {
          this.logger.warn(`Failed to cleanup temp files: ${error}`);
        });
      }
    }
  }

  /**
   * Process a single part: inspect content, extract metadata, create quarantine.
   *
   * @param part Parsed part from multipart parser
   * @param organizationId Organization (tenant) ID
   * @param importedByUserId User performing the upload
   * @returns Upload result item with quarantine record
   * @throws BadRequestException on inspection or metadata extraction failure
   * @throws ConflictException if already quarantined (deduplication)
   */
  private async processAndQuarantinePart(
    part: ParsedPart,
    organizationId: string,
    importedByUserId: string,
  ): Promise<UploadResultItem> {
    try {
      // 1. Read file content from temporary path
      const content = await readFile(part.tempPath);

      this.logger.debug(
        `Processing part: ${part.filename}, size: ${part.size}, hash: ${part.hash}`,
      );

      // 2. Inspect content
      const inspection = await this.inspector.inspectContent(
        content,
        part.hash,
        part.detectedType,
      );

      let quarantineReason: CredentialQuarantineReasonCode;

      if (!inspection.passed) {
        quarantineReason = inspection.reason;
      } else {
        // Content passed inspection; extract metadata to determine reason
        const metadata = await this.extractMetadata(content, part);
        quarantineReason = await this.determineQuarantineReason(
          content,
          metadata,
          part,
        );
      }

      this.logger.debug(
        `Inspection result for ${part.filename}: reason=${quarantineReason}`,
      );

      // 3. Extract safe metadata (never raw credential)
      const metadata = await this.extractMetadata(content, part);

      // 4. Create quarantine record
      let quarantine: CredentialQuarantine;

      try {
        quarantine = await this.quarantineService.createQuarantine({
          organizationId,
          reason: quarantineReason,
          metadata,
          importedByUserId,
        });
      } catch (error) {
        if (error instanceof ConflictException) {
          // Already quarantined; log and re-throw
          this.logger.warn(
            `Deduplication: part ${part.filename} already quarantined`,
          );
          throw error;
        }
        if (error instanceof PayloadTooLargeException) {
          // Capacity exceeded; log and re-throw
          this.logger.warn(
            `Capacity exceeded for org ${organizationId}`,
          );
          throw error;
        }
        throw error;
      }

      const result: UploadResultItem = {
        filename: part.filename,
        hash: part.hash,
        quarantineId: quarantine.id,
        state: quarantine.state,
        reason: quarantine.reason,
        size: part.size,
      };

      this.logger.log(
        `Quarantined part: ${part.filename}, id: ${quarantine.id}, reason: ${quarantineReason}`,
      );

      return result;
    } finally {
      // Always clean up temporary file
      try {
        await unlink(part.tempPath);
      } catch (error) {
        this.logger.warn(`Failed to delete temp file: ${error}`);
      }
    }
  }

  /**
   * Extract safe metadata from credential (never raw credential).
   *
   * Attempts to parse as JSON and extract safe fields. Falls back to
   * binary metadata if JSON parsing fails.
   *
   * @param content File content buffer
   * @param part Parsed part with detection info
   * @returns Safe metadata for quarantine record
   */
  private async extractMetadata(
    content: Buffer,
    part: ParsedPart,
  ): Promise<{
    contentHash: string;
    contentSize: number;
    schemaType: string;
    schemaVersion: string;
    issuerIdentifier: string;
    issuerPolicyVersion?: number;
    credentialProofType?: string;
    credentialExpiresAt?: Date;
    credentialIssuedAt?: Date;
    keyId?: string;
    keyType?: string;
    network?: string;
  }> {
    const baseMetadata = {
      contentHash: part.hash,
      contentSize: part.size,
      schemaType: 'Unknown',
      schemaVersion: 'Unknown',
      issuerIdentifier: 'Unknown',
    };

    // Try to extract from JSON if detected as JSON
    if (part.detectedType === 'json' || part.mimeType === 'application/json') {
      try {
        const json = JSON.parse(content.toString('utf-8'));

        return {
          ...baseMetadata,
          schemaType: json.type || 'Unknown',
          schemaVersion: json.schemaVersion || 'Unknown',
          issuerIdentifier: json.issuer || 'Unknown',
          credentialProofType: json.claim?.proofType,
          credentialExpiresAt: json.expiresAt
            ? new Date(json.expiresAt)
            : undefined,
          credentialIssuedAt: json.issuedAt
            ? new Date(json.issuedAt)
            : undefined,
          keyId: json.proof?.keyId,
          keyType: json.proof?.type,
          network: json.network,
        };
      } catch (error) {
        this.logger.debug(`Failed to extract JSON metadata: ${error}`);
      }
    }

    // Return base metadata for binary or unparseable files
    return baseMetadata;
  }

  /**
   * Determine quarantine reason based on content and metadata.
   *
   * For content that passed inspection, determine why it should be
   * quarantined (e.g., untrusted issuer, missing key, etc.).
   *
   * @param content File content buffer
   * @param metadata Extracted metadata
   * @param part Parsed part
   * @returns Quarantine reason code
   */
  private async determineQuarantineReason(
    content: Buffer,
    metadata: any,
    part: ParsedPart,
  ): Promise<CredentialQuarantineReasonCode> {
    // If we can't parse JSON, treat as suspicious
    if (part.detectedType !== 'json' && part.mimeType !== 'application/json') {
      return 'SUSPICIOUS';
    }

    // For now, all uploaded credentials are quarantined for review
    // In production, could implement logic to:
    // - Accept known-good issuers immediately
    // - Reject known-bad issuers
    // - Require manual review for unknowns

    // Quarantine all for safety (default conservative behavior)
    return 'MALFORMED';
  }
}

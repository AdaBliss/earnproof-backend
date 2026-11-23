/**
 * Schema Replacement Notice Controller (#395)
 * 
 * HTTP API endpoints for managing project schema activation notices and replacements.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { SchemaReplacementService } from "./schema-replacement.service";
import {
  InitiateSchemaReplacementInput,
  AcknowledgeSchemaReplacementInput,
  SchemaReplacementNoticeDto,
  SchemaReplacementAcknowledgementDto,
  SchemaReplacementReadinessDto,
  ListSchemaReplacementNoticesOptions,
  ListSchemaReplacementAcknowledgementsOptions,
} from "./schema-replacement.types";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { AuthenticatedUser } from "../auth/auth.types";

/**
 * DTO for initiating a schema replacement via HTTP.
 */
export class InitiateSchemaReplacementDto
  implements InitiateSchemaReplacementInput {
  predecessorSchemaId: string;
  successorSchemaId: string;
  deprecationDeadline: string;
  sunsetDeadline?: string;
  initiatedBy: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

/**
 * DTO for acknowledging a schema replacement via HTTP.
 */
export class AcknowledgeSchemaReplacementDto
  implements AcknowledgeSchemaReplacementInput {
  organizationId: string;
  acknowledgedBy: string;
  actionTaken?: string;
  actionAt?: Date;
  note?: string;
}

/**
 * Query parameters for listing schema replacement notices.
 */
export class ListSchemaReplacementNoticesQueryDto {
  predecessorSchemaId?: string;
  successorSchemaId?: string;
  status?: string;
  upcomingDeadlineDays?: number;
  skip?: number;
  take?: number;
}

/**
 * Query parameters for listing acknowledgements.
 */
export class ListSchemaReplacementAcknowledgementsQueryDto {
  status?: string;
  organizationId?: string;
  skip?: number;
  take?: number;
}

@ApiTags("Schema Replacements")
@Controller("schema-replacements")
@UseGuards(AuthGuard)
export class SchemaReplacementController {
  constructor(private readonly service: SchemaReplacementService) {}

  /**
   * POST /schema-replacements
   * Initiate a new schema replacement notice.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Initiate schema replacement notice",
    description:
      "Create a new schema replacement notice to notify projects of a schema deprecation and successor.",
  })
  async initiateReplacement(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InitiateSchemaReplacementDto,
  ): Promise<SchemaReplacementNoticeDto> {
    const input: InitiateSchemaReplacementInput = {
      ...dto,
      initiatedBy: dto.initiatedBy || user.id,
    };

    return this.service.initiateReplacement(input);
  }

  /**
   * GET /schema-replacements/:id
   * Retrieve a schema replacement notice by ID.
   */
  @Get(":id")
  @ApiOperation({
    summary: "Get schema replacement notice",
    description: "Retrieve a schema replacement notice with acknowledgement summary.",
  })
  async getNotice(@Param("id") id: string): Promise<SchemaReplacementNoticeDto> {
    return this.service.getNotice(id);
  }

  /**
   * GET /schema-replacements
   * List schema replacement notices with optional filtering.
   */
  @Get()
  @ApiOperation({
    summary: "List schema replacement notices",
    description:
      "List schema replacement notices with optional filtering by predecessor, successor, status, or deadline.",
  })
  async listNotices(
    @Query() query: ListSchemaReplacementNoticesQueryDto,
  ): Promise<SchemaReplacementNoticeDto[]> {
    const options: ListSchemaReplacementNoticesOptions = {
      predecessorSchemaId: query.predecessorSchemaId,
      successorSchemaId: query.successorSchemaId,
      status: query.status as any,
      upcomingDeadlineDays: query.upcomingDeadlineDays,
      skip: query.skip,
      take: query.take,
    };

    return this.service.listNotices(options);
  }

  /**
   * POST /schema-replacements/:id/acknowledge
   * Acknowledge a schema replacement notice on behalf of an organization.
   */
  @Post(":id/acknowledge")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Acknowledge schema replacement",
    description:
      "Record an organization acknowledgement of a schema replacement notice.",
  })
  async acknowledgeReplacement(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") noticeId: string,
    @Body() dto: AcknowledgeSchemaReplacementDto,
  ): Promise<SchemaReplacementAcknowledgementDto> {
    const input: AcknowledgeSchemaReplacementInput = {
      ...dto,
      acknowledgedBy: dto.acknowledgedBy || user.id,
    };

    return this.service.acknowledgeReplacement(noticeId, input);
  }

  /**
   * GET /schema-replacements/:id/acknowledgements
   * List acknowledgements for a schema replacement notice.
   */
  @Get(":id/acknowledgements")
  @ApiOperation({
    summary: "List schema replacement acknowledgements",
    description: "List organizations that have acknowledged a schema replacement notice.",
  })
  async listAcknowledgements(
    @Param("id") noticeId: string,
    @Query() query: ListSchemaReplacementAcknowledgementsQueryDto,
  ): Promise<SchemaReplacementAcknowledgementDto[]> {
    const options: ListSchemaReplacementAcknowledgementsOptions = {
      noticeId,
      status: query.status as any,
      organizationId: query.organizationId,
      skip: query.skip,
      take: query.take,
    };

    return this.service.listAcknowledgements(options);
  }

  /**
   * GET /schema-replacements/:id/readiness
   * Assess schema replacement readiness for activation.
   */
  @Get(":id/readiness")
  @ApiOperation({
    summary: "Assess schema replacement readiness",
    description:
      "Perform a readiness assessment for a schema replacement notice, checking for blocking findings and organization acknowledgements.",
  })
  async assessReadiness(
    @Param("id") noticeId: string,
  ): Promise<SchemaReplacementReadinessDto> {
    return this.service.assessReadiness(noticeId);
  }
}

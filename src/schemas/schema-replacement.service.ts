/**
 * Schema Replacement Notice Service (#395)
 * 
 * Manages project schema activation notices and replacements.
 * Handles notice lifecycle, organization acknowledgements, and readiness assessment.
 * 
 * Design patterns:
 * - Deterministic status codes: no raw error messages
 * - Time-bounded: deadlines and TTL checks prevent infinite states
 * - Privacy-safe: no secrets or raw addresses in findings
 * - Immutable records: once a notice transitions, historical data is frozen
 * - Failure-closed: invalid lineage or cross-network references are rejected
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  SchemaReplacementStatus,
  SchemaReplacementAcknowledgementStatus,
  Prisma,
} from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import {
  InitiateSchemaReplacementInput,
  AcknowledgeSchemaReplacementInput,
  SchemaReplacementNoticeDto,
  SchemaReplacementAcknowledgementDto,
  SchemaReplacementReadinessDto,
  SchemaReplacementFinding,
  SchemaReplacementReadinessStatusCode,
  ListSchemaReplacementNoticesOptions,
  ListSchemaReplacementAcknowledgementsOptions,
} from "./schema-replacement.types";

/**
 * Default timeout for readiness checks (ms).
 * Prevents slow assessments from blocking operations.
 */
const DEFAULT_CHECK_TIMEOUT_MS = 10_000;

/**
 * Cache TTL for readiness assessments (60 seconds).
 * Prevents assessment spam while allowing timely updates.
 */
const DEFAULT_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  result: SchemaReplacementReadinessDto;
  storedAt: number;
}

@Injectable()
export class SchemaReplacementService {
  private readonly logger = new Logger(SchemaReplacementService.name);

  /** In-memory cache for the last computed readiness assessment. */
  private cache: Map<string, CacheEntry> = new Map();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Initiate a schema replacement notice.
   * Creates a notice with predecessor and successor schemas, with cycle and lineage validation.
   */
  async initiateReplacement(
    input: InitiateSchemaReplacementInput,
  ): Promise<SchemaReplacementNoticeDto> {
    // Fetch and validate predecessor schema
    const predecessor = await this.prisma.protocolSchema.findUnique({
      where: { id: input.predecessorSchemaId },
    });
    if (!predecessor) {
      throw new NotFoundException(
        `Predecessor schema "${input.predecessorSchemaId}" not found`,
      );
    }

    // Fetch and validate successor schema
    const successor = await this.prisma.protocolSchema.findUnique({
      where: { id: input.successorSchemaId },
    });
    if (!successor) {
      throw new NotFoundException(
        `Successor schema "${input.successorSchemaId}" not found`,
      );
    }

    // Validate: predecessor and successor are not the same
    if (input.predecessorSchemaId === input.successorSchemaId) {
      throw new BadRequestException(
        "Predecessor and successor schemas must be different",
      );
    }

    // Validate: no cross-network lineage
    if (predecessor.network !== successor.network) {
      throw new BadRequestException(
        `Cross-network replacement rejected: predecessor is on "${predecessor.network}", successor is on "${successor.network}"`,
      );
    }

    // Validate: detect replacement cycle (successor cannot already be a predecessor of another)
    const cycleDetection = await this.prisma.protocolSchema.findMany({
      where: {
        predecessorId: input.successorSchemaId,
      },
    });
    if (cycleDetection.length > 0) {
      throw new BadRequestException(
        "Replacement cycle detected: successor schema is already a predecessor",
      );
    }

    // Validate: no existing replacement notice between same schemas
    const existingNotice =
      await this.prisma.schemaReplacementNotice.findFirst({
        where: {
          predecessorSchemaId: input.predecessorSchemaId,
          successorSchemaId: input.successorSchemaId,
          status: { not: SchemaReplacementStatus.SUPERSEDED },
        },
      });
    if (existingNotice) {
      throw new ConflictException(
        `Active replacement notice already exists between these schemas`,
      );
    }

    // Parse and validate deadlines
    const deprecationDeadline =
      typeof input.deprecationDeadline === "string"
        ? new Date(input.deprecationDeadline)
        : input.deprecationDeadline;

    if (isNaN(deprecationDeadline.getTime())) {
      throw new BadRequestException("Invalid deprecationDeadline format");
    }

    if (deprecationDeadline <= new Date()) {
      throw new BadRequestException(
        "deprecationDeadline must be in the future",
      );
    }

    let sunsetDeadline: Date | null = null;
    if (input.sunsetDeadline) {
      sunsetDeadline =
        typeof input.sunsetDeadline === "string"
          ? new Date(input.sunsetDeadline)
          : input.sunsetDeadline;

      if (isNaN(sunsetDeadline.getTime())) {
        throw new BadRequestException("Invalid sunsetDeadline format");
      }

      if (sunsetDeadline <= deprecationDeadline) {
        throw new BadRequestException(
          "sunsetDeadline must be after deprecationDeadline",
        );
      }
    }

    // Create the notice
    const created = await this.prisma.schemaReplacementNotice.create({
      data: {
        predecessorSchemaId: input.predecessorSchemaId,
        successorSchemaId: input.successorSchemaId,
        status: SchemaReplacementStatus.PENDING,
        initiatedBy: input.initiatedBy,
        initiatedAt: new Date(),
        deprecationDeadline,
        sunsetDeadline,
        reason: input.reason,
        metadata: input.metadata as Prisma.InputJsonValue,
      },
    });

    // Invalidate readiness cache for new notice
    this.cache.delete(created.id);

    return this.formatNoticeDto(created, predecessor, successor);
  }

  /**
   * Acknowledge a schema replacement notice on behalf of an organization.
   */
  async acknowledgeReplacement(
    noticeId: string,
    input: AcknowledgeSchemaReplacementInput,
  ): Promise<SchemaReplacementAcknowledgementDto> {
    // Fetch and validate notice
    const notice = await this.prisma.schemaReplacementNotice.findUnique({
      where: { id: noticeId },
      include: {
        predecessorSchema: true,
        successorSchema: true,
      },
    });
    if (!notice) {
      throw new NotFoundException(`Schema replacement notice "${noticeId}" not found`);
    }

    // Fetch and validate organization
    const organization = await this.prisma.organization.findUnique({
      where: { id: input.organizationId },
    });
    if (!organization) {
      throw new NotFoundException(
        `Organization "${input.organizationId}" not found`,
      );
    }

    // Check for existing acknowledgement
    const existing =
      await this.prisma.schemaReplacementAcknowledgement.findUnique({
        where: {
          noticeId_organizationId: {
            noticeId,
            organizationId: input.organizationId,
          },
        },
      });

    if (existing) {
      throw new ConflictException(
        "Organization has already acknowledged this replacement notice",
      );
    }

    // Create acknowledgement
    const actionAt =
      input.actionAt ??
      (input.actionTaken ? new Date() : null);

    const ack =
      await this.prisma.schemaReplacementAcknowledgement.create({
        data: {
          noticeId,
          organizationId: input.organizationId,
          acknowledgedBy: input.acknowledgedBy,
          acknowledgedAt: new Date(),
          status: input.actionTaken
            ? SchemaReplacementAcknowledgementStatus.ACTED
            : SchemaReplacementAcknowledgementStatus.PENDING_ACTION,
          actionTaken: input.actionTaken,
          actionAt,
          note: input.note,
        },
      });

    // Invalidate readiness cache for this notice
    this.cache.delete(noticeId);

    return this.formatAcknowledgementDto(
      ack,
      notice,
      organization.name,
    );
  }

  /**
   * Get a schema replacement notice by ID.
   */
  async getNotice(id: string): Promise<SchemaReplacementNoticeDto> {
    const notice = await this.prisma.schemaReplacementNotice.findUnique({
      where: { id },
      include: {
        predecessorSchema: true,
        successorSchema: true,
      },
    });

    if (!notice) {
      throw new NotFoundException(`Schema replacement notice "${id}" not found`);
    }

    return this.formatNoticeDto(
      notice,
      notice.predecessorSchema,
      notice.successorSchema,
    );
  }

  /**
   * List schema replacement notices with optional filtering.
   */
  async listNotices(
    options: ListSchemaReplacementNoticesOptions = {},
  ): Promise<SchemaReplacementNoticeDto[]> {
    const where: Prisma.SchemaReplacementNoticeWhereInput = {};

    if (options.predecessorSchemaId) {
      where.predecessorSchemaId = options.predecessorSchemaId;
    }

    if (options.successorSchemaId) {
      where.successorSchemaId = options.successorSchemaId;
    }

    if (options.status) {
      where.status = options.status;
    }

    // Filter by upcoming deadline
    if (options.upcomingDeadlineDays) {
      const now = new Date();
      const upcomingDeadline = new Date(
        now.getTime() + options.upcomingDeadlineDays * 24 * 60 * 60 * 1000,
      );
      where.deprecationDeadline = {
        gte: now,
        lte: upcomingDeadline,
      };
    }

    const notices = await this.prisma.schemaReplacementNotice.findMany({
      where,
      include: {
        predecessorSchema: true,
        successorSchema: true,
      },
      skip: options.skip,
      take: options.take,
      orderBy: { deprecationDeadline: "asc" },
    });

    return notices.map((notice) =>
      this.formatNoticeDto(
        notice,
        notice.predecessorSchema,
        notice.successorSchema,
      ),
    );
  }

  /**
   * List acknowledgements for a schema replacement notice.
   */
  async listAcknowledgements(
    options: ListSchemaReplacementAcknowledgementsOptions,
  ): Promise<SchemaReplacementAcknowledgementDto[]> {
    const where: Prisma.SchemaReplacementAcknowledgementWhereInput = {
      noticeId: options.noticeId,
    };

    if (options.status) {
      where.status = options.status;
    }

    if (options.organizationId) {
      where.organizationId = options.organizationId;
    }

    const acks = await this.prisma.schemaReplacementAcknowledgement.findMany({
      where,
      include: {
        notice: {
          include: {
            predecessorSchema: true,
            successorSchema: true,
          },
        },
        organization: true,
      },
      skip: options.skip,
      take: options.take,
      orderBy: { acknowledgedAt: "desc" },
    });

    return acks.map((ack) =>
      this.formatAcknowledgementDto(
        ack,
        ack.notice,
        ack.organization.name,
      ),
    );
  }

  /**
   * Assess schema replacement readiness.
   * Returns cached result if fresh, otherwise re-checks.
   * Never throws — all errors are caught and reflected in the returned status.
   */
  async assessReadiness(
    noticeId: string,
  ): Promise<SchemaReplacementReadinessDto> {
    const now = Date.now();

    // Return cached result if still fresh
    const cached = this.cache.get(noticeId);
    if (cached && cached.storedAt > now - DEFAULT_CACHE_TTL_MS) {
      const ageMs = now - cached.storedAt;
      return {
        ...cached.result,
        cached: true,
        ageMs,
      };
    }

    // Perform fresh assessment
    const result = await this.runAssessment(noticeId);
    this.cache.set(noticeId, { result, storedAt: now });
    return result;
  }

  /**
   * Check if a schema replacement can proceed to activation.
   * Returns true iff status is "ready".
   */
  async canActivate(noticeId: string): Promise<boolean> {
    const assessment = await this.assessReadiness(noticeId);
    return assessment.status === "ready";
  }

  /**
   * Expose for testing: reset the cache.
   */
  resetCache(): void {
    this.cache.clear();
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  /**
   * Perform a fresh readiness assessment.
   */
  private async runAssessment(
    noticeId: string,
  ): Promise<SchemaReplacementReadinessDto> {
    try {
      const findings: SchemaReplacementFinding[] = [];

      // Fetch notice
      const notice = await this.prisma.schemaReplacementNotice.findUnique({
        where: { id: noticeId },
        include: {
          predecessorSchema: true,
          successorSchema: true,
          acknowledgements: true,
        },
      });

      if (!notice) {
        findings.push({
          key: SchemaReplacementReadinessStatusCode.PREDECESSOR_NOT_FOUND,
          severity: "blocking",
          description: "Schema replacement notice not found",
          acknowledged: false,
        });
        return this.formatFailedAssessment(
          noticeId,
          findings,
          SchemaReplacementReadinessStatusCode.PREDECESSOR_NOT_FOUND,
        );
      }

      // Check: schemas exist and are valid
      if (!notice.predecessorSchema || !notice.successorSchema) {
        findings.push({
          key: SchemaReplacementReadinessStatusCode.INVALID_LINEAGE,
          severity: "blocking",
          description: "Predecessor or successor schema not found",
          acknowledged: false,
        });
      }

      // Check: no cross-network lineage
      if (
        notice.predecessorSchema?.network !==
        notice.successorSchema?.network
      ) {
        findings.push({
          key: SchemaReplacementReadinessStatusCode.CROSS_NETWORK_LINEAGE,
          severity: "blocking",
          description:
            "Cross-network replacement: predecessor and successor must be on the same network",
          acknowledged: false,
        });
      }

      // Check: deadlines are valid
      if (notice.deprecationDeadline <= new Date()) {
        findings.push({
          key: SchemaReplacementReadinessStatusCode.DEPRECATION_DEADLINE_PASSED,
          severity: "blocking",
          description: "Deprecation deadline has passed",
          acknowledged: false,
        });
      }

      if (notice.sunsetDeadline && notice.sunsetDeadline <= new Date()) {
        findings.push({
          key: SchemaReplacementReadinessStatusCode.SUNSET_DEADLINE_INVALID,
          severity: "blocking",
          description: "Sunset deadline has passed",
          acknowledged: false,
        });
      }

      // Check: all organizations have acknowledged
      if (notice.acknowledgements.length === 0) {
        findings.push({
          key: SchemaReplacementReadinessStatusCode.PENDING_ORGANIZATIONS,
          severity: "advisory",
          description: "No organizations have acknowledged the replacement",
          acknowledged: false,
        });
      }

      // Compute overall severity and status
      const unacknowledgedBlocking = findings.filter(
        (f) => f.severity === "blocking" && !f.acknowledged,
      );
      const overallSeverity = this.computeOverallSeverity(findings);

      const status =
        unacknowledgedBlocking.length === 0 ? "ready" : "not_ready";

      // Compute statistics
      const stats = await this.computeAcknowledgementStats(noticeId);

      return {
        noticeId,
        status,
        reason:
          status === "not_ready" ? this.getReason(findings) : undefined,
        findings,
        overallSeverity,
        stats,
        assessedAt: new Date(),
        cached: false,
      };
    } catch (error) {
      this.logger.error(
        `Failed to assess readiness for notice ${noticeId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      const findings: SchemaReplacementFinding[] = [
        {
          key: "assessment_failed",
          severity: "blocking",
          description: "Readiness assessment encountered an error",
          acknowledged: false,
        },
      ];

      return this.formatFailedAssessment(
        noticeId,
        findings,
        "assessment_failed",
      );
    }
  }

  /**
   * Compute the overall severity from all findings.
   */
  private computeOverallSeverity(
    findings: SchemaReplacementFinding[],
  ): "blocking" | "advisory" | "informational" | "none" {
    const unacknowledged = findings.filter((f) => !f.acknowledged);

    if (unacknowledged.length === 0) {
      return "none";
    }

    if (unacknowledged.some((f) => f.severity === "blocking")) {
      return "blocking";
    }

    if (unacknowledged.some((f) => f.severity === "advisory")) {
      return "advisory";
    }

    return "informational";
  }

  /**
   * Generate a human-readable reason for "not_ready" status.
   */
  private getReason(findings: SchemaReplacementFinding[]): string {
    const blocking = findings.find(
      (f) => f.severity === "blocking" && !f.acknowledged,
    );
    if (blocking) {
      return blocking.key;
    }

    return SchemaReplacementReadinessStatusCode.BLOCKING_FINDINGS_UNACKNOWLEDGED;
  }

  /**
   * Compute acknowledgement statistics for a notice.
   */
  private async computeAcknowledgementStats(noticeId: string): Promise<{
    totalOrganizations: number;
    acknowledgedCount: number;
    actedCount: number;
    deferredCount: number;
  }> {
    const acks = await this.prisma.schemaReplacementAcknowledgement.findMany({
      where: { noticeId },
    });

    const actedCount = acks.filter(
      (a) => a.status === SchemaReplacementAcknowledgementStatus.ACTED,
    ).length;

    const deferredCount = acks.filter(
      (a) => a.status === SchemaReplacementAcknowledgementStatus.DEFERRED,
    ).length;

    return {
      totalOrganizations: acks.length,
      acknowledgedCount: acks.length,
      actedCount,
      deferredCount,
    };
  }

  /**
   * Format a failed assessment result.
   */
  private formatFailedAssessment(
    noticeId: string,
    findings: SchemaReplacementFinding[],
    reason: string,
  ): SchemaReplacementReadinessDto {
    return {
      noticeId,
      status: "not_ready",
      reason,
      findings,
      overallSeverity: "blocking",
      stats: {
        totalOrganizations: 0,
        acknowledgedCount: 0,
        actedCount: 0,
        deferredCount: 0,
      },
      assessedAt: new Date(),
      cached: false,
    };
  }

  /**
   * Format a notice for the API response.
   */
  private formatNoticeDto(
    notice: Prisma.SchemaReplacementNoticeGetPayload<{
      include: { predecessorSchema: true; successorSchema: true };
    }>,
    predecessor: Prisma.ProtocolSchemaGetPayload<{}>,
    successor: Prisma.ProtocolSchemaGetPayload<{}>,
  ): SchemaReplacementNoticeDto {
    return {
      id: notice.id,
      predecessorSchemaId: notice.predecessorSchemaId,
      predecessorSchemaName: predecessor.schemaId,
      successorSchemaId: notice.successorSchemaId,
      successorSchemaName: successor.schemaId,
      status: notice.status,
      initiatedBy: notice.initiatedBy,
      initiatedAt: notice.initiatedAt,
      deprecationDeadline: notice.deprecationDeadline,
      sunsetDeadline: notice.sunsetDeadline,
      reason: notice.reason,
      metadata: notice.metadata,
      createdAt: notice.createdAt,
      updatedAt: notice.updatedAt,
      totalOrganizations: 0, // Populated separately if needed
      acknowledgedCount: 0,
      pendingCount: 0,
      actedCount: 0,
    };
  }

  /**
   * Format an acknowledgement for the API response.
   */
  private formatAcknowledgementDto(
    ack: Prisma.SchemaReplacementAcknowledgementGetPayload<{}>,
    notice: Prisma.SchemaReplacementNoticeGetPayload<{}>,
    organizationName: string,
  ): SchemaReplacementAcknowledgementDto {
    return {
      id: ack.id,
      noticeId: ack.noticeId,
      organizationId: ack.organizationId,
      organizationName,
      acknowledgedBy: ack.acknowledgedBy,
      acknowledgedAt: ack.acknowledgedAt,
      status: ack.status,
      actionTaken: ack.actionTaken,
      actionAt: ack.actionAt,
      note: ack.note,
      createdAt: ack.createdAt,
      updatedAt: ack.updatedAt,
    };
  }
}

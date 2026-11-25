import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { IssuerAssuranceLevel, Prisma, ResourceStatus } from "@prisma/client";
import { createHash } from "crypto";
import { AuthenticatedUser } from "../auth/auth.types";
import { sha256 } from "../common/crypto/hash";
import {
  buildPage,
  cursorOrderBy,
  cursorWhereFragment,
} from "../common/pagination/keyset-paginate";
import { PageInfo } from "../common/pagination/pagination.dto";
import { PrismaService } from "../database/prisma.service";
import { ConflictException as OptimisticLockConflictException } from "../common/exceptions/domain.exceptions";
import { IssuerRegistryService } from "./issuer-registry.service";
import {
  DEFAULT_ACCREDITATION_CLOCK_SKEW_MS,
  DEFAULT_ACCREDITATION_MAX_AGE_MS,
  accreditationStatusWhereInput,
  computeEffectiveAccreditationStatus,
  isAccreditationStale,
} from "./issuer-assurance";
import { CreateIssuerDto } from "./dto/create-issuer.dto";
import {
  IssuerPublicResponseDto,
  IssuerResponseDto,
} from "./dto/issuer-response.dto";
import { ListIssuersDto } from "./dto/list-issuers.dto";
import { SyncIssuerStatusResponseDto } from "./dto/sync-issuer-status.dto";
import { UpdateIssuerMetadataDto } from "./dto/update-issuer-metadata.dto";
import { UpdateIssuerStatusDto } from "./dto/update-issuer-status.dto";

// Valid status transitions
const VALID_TRANSITIONS: Record<ResourceStatus, ResourceStatus[]> = {
  [ResourceStatus.PENDING]: [ResourceStatus.ACTIVE],
  [ResourceStatus.ACTIVE]: [ResourceStatus.SUSPENDED, ResourceStatus.REVOKED],
  [ResourceStatus.SUSPENDED]: [ResourceStatus.ACTIVE, ResourceStatus.REVOKED],
  [ResourceStatus.REVOKED]: [],
  [ResourceStatus.DELETED]: [],
  // Issuers never take EXPIRED (it is an attestation-only effective status);
  // listed here to keep the transition map total over ResourceStatus.
  [ResourceStatus.EXPIRED]: [],
};

@Injectable()
export class IssuersService {
  private readonly logger = new Logger(IssuersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly issuerRegistryService: IssuerRegistryService,
  ) {}

  async createIssuer(
    user: AuthenticatedUser,
    input: CreateIssuerDto,
  ): Promise<IssuerResponseDto> {
    if (user.role !== "ADMIN") {
      throw new ForbiddenException("Only admins can create issuers");
    }

    // Verify organization exists and user has access
    const org = await this.prisma.organization.findUnique({
      where: { id: input.organizationId },
    });

    if (!org) {
      throw new NotFoundException(
        `Organization with ID "${input.organizationId}" not found`,
      );
    }

    if (org.archivedAt) {
      throw new ConflictException(
        "Organization is archived; issuers cannot be registered",
      );
    }

    // Check if admin is organization creator (admins can manage any org, but log it)
    if (user.role !== "ADMIN" && org.createdById !== user.id) {
      throw new ForbiddenException(
        "You do not have permission to manage this organization",
      );
    }

    // Check if issuer with this stellar address already exists
    const existing = await this.prisma.issuer.findUnique({
      where: { stellarAddress: input.stellarAddress },
    });

    if (existing) {
      throw new ConflictException(
        `Issuer with Stellar address "${input.stellarAddress}" already exists`,
      );
    }

    // An address that another issuer is rotating onto, or that an issuer used
    // to hold, stays reserved: registering it would either collide with a
    // rotation in flight or make historical attestations ambiguous.
    const reserved =
      (await this.prisma.issuerAddressRotation.findUnique({
        where: { openTargetKey: input.stellarAddress },
        select: { id: true },
      })) ??
      (await this.prisma.issuerAddressHistory.findFirst({
        where: { stellarAddress: input.stellarAddress },
        select: { id: true },
      }));
    if (reserved) {
      throw new ConflictException(
        "This Stellar address is reserved by an issuer address rotation",
      );
    }

    // Validate Stellar address format (basic check)
    if (!this.isValidStellarAddress(input.stellarAddress)) {
      throw new BadRequestException("Invalid Stellar public key format");
    }

    const publicMetadata = this.allowlistedMetadata(input.publicMetadata);
    const issuer = await this.prisma.issuer.create({
      data: {
        organizationId: input.organizationId,
        stellarAddress: input.stellarAddress,
        status: ResourceStatus.PENDING,
        revision: 0,
        publicMetadata,
        metadataHash: Object.keys(publicMetadata).length
          ? this.hashMetadata(publicMetadata)
          : null,
      },
    });

    // Log audit event
    await this.createAuditLog(user, "CREATE", "Issuer", issuer.id, {
      organizationId: input.organizationId,
      stellarAddress: input.stellarAddress,
      publicMetadata,
    });

    return this.toResponseDto(issuer);
  }

  async updateIssuerMetadata(
    user: AuthenticatedUser,
    issuerId: string,
    input: UpdateIssuerMetadataDto,
  ): Promise<IssuerResponseDto> {
    if (user.role !== "ADMIN") {
      throw new ForbiddenException("Only admins can update issuer metadata");
    }

    const issuer = await this.getIssuerById(issuerId);
    const publicMetadata = this.allowlistedMetadata(input.publicMetadata);
    const metadataHash = this.hashMetadata(publicMetadata);

    // Attempt optimistic update with revision check
    const updated = await this.prisma.issuer.updateMany({
      where: {
        id: issuerId,
        revision: input.expectedRevision,
      },
      data: {
        metadataHash,
        publicMetadata,
        contractSyncState: "PENDING",
        contractSyncError: null,
        revision: input.expectedRevision + 1,
      },
    });

    // If no records were updated, the revision didn't match
    if (updated.count === 0) {
      throw new OptimisticLockConflictException(
        "Issuer has been modified by another request. Please refresh and retry.",
        issuer.revision,
      );
    }

    const result = await this.prisma.issuer.findUniqueOrThrow({
      where: { id: issuerId },
    });

    // Log audit event
    await this.createAuditLog(user, "UPDATE_METADATA", "Issuer", issuerId, {
      previousMetadataHash: issuer.metadataHash,
      newMetadataHash: metadataHash,
      publicMetadata,
      revision: result.revision,
    });

    return this.toResponseDto(result);
  }

  async updateIssuerStatus(
    user: AuthenticatedUser,
    issuerId: string,
    input: UpdateIssuerStatusDto,
  ): Promise<IssuerResponseDto> {
    if (user.role !== "ADMIN") {
      throw new ForbiddenException("Only admins can update issuer status");
    }

    const issuer = await this.getIssuerById(issuerId);

    // Validate status transition
    const validNextStatuses = VALID_TRANSITIONS[issuer.status];
    if (!validNextStatuses.includes(input.status)) {
      throw new BadRequestException(
        `Invalid status transition: ${issuer.status} → ${input.status}. ` +
          `Valid transitions from ${issuer.status} are: ${validNextStatuses.join(", ") || "none"}`,
      );
    }

    // Re-activating an issuer vouches for new attestations, which an archived
    // organization may not do. Suspending or revoking stays allowed, so an
    // archived organization can still be wound down.
    if (input.status === ResourceStatus.ACTIVE) {
      const org = await this.prisma.organization.findUnique({
        where: { id: issuer.organizationId },
        select: { archivedAt: true },
      });
      if (org?.archivedAt) {
        throw new ConflictException(
          "Organization is archived; its issuers cannot be activated",
        );
      }
    }

    const now = new Date();
    const updateData: any = {
      status: input.status,
      contractSyncState: "PENDING",
      contractSyncError: null,
      revision: input.expectedRevision + 1,
    };

    // Update timestamp fields based on transition
    if (
      input.status === ResourceStatus.ACTIVE &&
      issuer.status === ResourceStatus.PENDING
    ) {
      updateData.verifiedAt = now;
    } else if (
      input.status === ResourceStatus.SUSPENDED &&
      issuer.status === ResourceStatus.ACTIVE
    ) {
      updateData.suspendedAt = now;
    } else if (input.status === ResourceStatus.REVOKED) {
      updateData.revokedAt = now;
    }

    // Attempt optimistic update with revision check
    const updated = await this.prisma.issuer.updateMany({
      where: {
        id: issuerId,
        revision: input.expectedRevision,
      },
      data: updateData,
    });

    // If no records were updated, the revision didn't match
    if (updated.count === 0) {
      throw new OptimisticLockConflictException(
        "Issuer has been modified by another request. Please refresh and retry.",
        issuer.revision,
      );
    }

    const result = await this.prisma.issuer.findUniqueOrThrow({
      where: { id: issuerId },
    });

    // Log audit event
    await this.createAuditLog(user, "UPDATE_STATUS", "Issuer", issuerId, {
      previousStatus: issuer.status,
      newStatus: input.status,
      timestamp: now.toISOString(),
      revision: result.revision,
    });

    return this.toResponseDto(result);
  }

  async getIssuer(issuerId: string): Promise<IssuerResponseDto> {
    const issuer = await this.getIssuerById(issuerId);
    return this.toResponseDto(issuer);
  }

  async getIssuerPublic(issuerId: string): Promise<IssuerPublicResponseDto> {
    const issuer = await this.getIssuerById(issuerId);
    return this.toPublicResponseDto(issuer, new Date());
  }

  async listIssuers(query: ListIssuersDto): Promise<{
    items: IssuerResponseDto[];
    total: number;
    limit: number;
    pageInfo: PageInfo;
  }> {
    const now = new Date();
    const limit = Math.min(query.limit || 20, 100);
    const cursorWhere = cursorWhereFragment(query.cursor, "createdAt");
    const filterWhere = this.issuerFilterWhere(query, now);

    const where: Prisma.IssuerWhereInput = {
      ...(cursorWhere as Prisma.IssuerWhereInput),
      ...filterWhere,
    };

    const [rows, total] = await Promise.all([
      this.prisma.issuer.findMany({
        where,
        take: limit + 1,
        orderBy: cursorOrderBy("createdAt"),
      }),
      this.prisma.issuer.count({ where: filterWhere }),
    ]);
    const { data, pageInfo } = buildPage(rows, limit, "createdAt");

    return {
      items: data.map((issuer) => this.toResponseDto(issuer, now)),
      total,
      limit,
      pageInfo,
    };
  }

  async listIssuersPublic(query: ListIssuersDto): Promise<{
    items: IssuerPublicResponseDto[];
    total: number;
    limit: number;
    pageInfo: PageInfo;
  }> {
    const now = new Date();
    const limit = Math.min(query.limit || 20, 100);
    const cursorWhere = cursorWhereFragment(query.cursor, "createdAt");

    // Public endpoint only shows active/trusted issuers. The caller's
    // `status` is ignored here (as before); `assuranceLevel` and
    // `accreditationStatus` narrow within the ACTIVE set.
    const filterWhere = this.issuerFilterWhere(
      { ...query, status: ResourceStatus.ACTIVE },
      now,
    );

    const where: Prisma.IssuerWhereInput = {
      ...(cursorWhere as Prisma.IssuerWhereInput),
      ...filterWhere,
    };

    const [rows, total] = await Promise.all([
      this.prisma.issuer.findMany({
        where,
        take: limit + 1,
        orderBy: cursorOrderBy("createdAt"),
      }),
      this.prisma.issuer.count({ where: filterWhere }),
    ]);
    const { data, pageInfo } = buildPage(rows, limit, "createdAt");

    return {
      items: data.map((issuer) => this.toPublicResponseDto(issuer, now)),
      total,
      limit,
      pageInfo,
    };
  }

  /**
   * Exact-match filters for issuer listings, without the cursor fragment
   * (so the same object can count the filtered set).
   *
   * The effective-accreditation fragment is combined under `AND`: it carries
   * its own implied `status`, so a caller-supplied `status` that disagrees
   * with it matches nothing instead of one filter silently winning. No
   * free-text or unbounded filter is accepted.
   */
  private issuerFilterWhere(
    query: ListIssuersDto,
    now: Date,
  ): Prisma.IssuerWhereInput {
    const where: Prisma.IssuerWhereInput = {};
    if (query.status) {
      where.status = query.status;
    }
    if (query.organizationId) {
      where.organizationId = query.organizationId;
    }
    if (query.assuranceLevel) {
      where.assuranceLevel = query.assuranceLevel;
    }
    if (query.accreditationStatus) {
      where.AND = [
        accreditationStatusWhereInput(query.accreditationStatus, now),
      ];
    }
    return where;
  }

  async syncIssuerStatus(
    user: AuthenticatedUser,
    issuerId: string,
  ): Promise<SyncIssuerStatusResponseDto> {
    if (user.role !== "ADMIN") {
      throw new ForbiddenException("Only admins can sync issuer status");
    }

    const issuer = await this.getIssuerById(issuerId);

    const result = await this.issuerRegistryService.sync({
      issuerId: issuer.id,
      stellarAddress: issuer.stellarAddress,
      metadataHash: issuer.metadataHash ?? sha256("{}"),
      status: issuer.status,
      contractSyncedStatus: issuer.contractSyncedStatus,
    });
    const state = result.state.toUpperCase() as
      "SYNCED" | "PENDING" | "FAILED" | "DISABLED";
    const syncedAt = new Date();

    await this.prisma.issuer.update({
      where: { id: issuerId },
      data:
        result.state === "synced"
          ? {
              contractSyncState: state,
              contractSyncedStatus: issuer.status,
              contractTransactionHash: result.transactionHash,
              contractSyncedAt: syncedAt,
              contractSyncError: null,
            }
          : {
              contractSyncState: state,
              contractSyncError:
                result.state === "failed" ? result.error : result.reason,
            },
    });

    // A successful sync is the moment the contract is known to have accepted
    // the issuer's state, so re-read the contract-backed assurance right away
    // and adopt it. Best-effort and fail-closed: if the read is disabled or
    // fails, the stored assurance is left untouched — the sync itself already
    // succeeded, and an unobserved accreditation must never be asserted from
    // tenant metadata or a stale projection.
    let assuranceRefreshed = false;
    if (result.state === "synced") {
      assuranceRefreshed = await this.refreshAssuranceFromContract(
        issuerId,
        result.transactionHash,
      );
    }

    await this.createAuditLog(user, "SYNC_STATUS", "Issuer", issuerId, {
      state,
      status: issuer.status,
      ...(result.state === "synced"
        ? {
            operation: result.operation,
            transactionHash: result.transactionHash,
            assuranceRefreshed,
          }
        : { reason: result.reason }),
    });

    return {
      issuerId,
      synced: result.state === "synced",
      state,
      currentStatus: issuer.status,
      ...(result.state === "synced"
        ? {
            operation: result.operation,
            transactionHash: result.transactionHash,
            assuranceRefreshed,
          }
        : {
            reason: result.reason,
            ...(result.state === "failed" ? { error: result.error } : {}),
          }),
    };
  }

  async getIssuerById(issuerId: string) {
    const issuer = await this.prisma.issuer.findUnique({
      where: { id: issuerId },
    });

    if (!issuer) {
      throw new NotFoundException(`Issuer with ID "${issuerId}" not found`);
    }

    return issuer;
  }

  private computeTrustStatus(
    issuer: any,
  ): "TRUSTED" | "PENDING" | "SUSPENDED" | "REVOKED" {
    if (issuer.status === ResourceStatus.REVOKED) return "REVOKED";
    if (issuer.status === ResourceStatus.SUSPENDED) return "SUSPENDED";
    if (issuer.status === ResourceStatus.ACTIVE && issuer.verifiedAt)
      return "TRUSTED";
    return "PENDING";
  }

  /**
   * Adopt the contract-backed assurance for an issuer after a successful
   * sync, from a fresh contract read. Returns whether the stored assurance
   * was refreshed. Never writes tenant-supplied values: the only inputs are
   * the registry read and the sync's transaction hash. A missing, disabled,
   * or failed read leaves the stored assurance untouched (fail closed).
   */
  private async refreshAssuranceFromContract(
    issuerId: string,
    transactionHash: string,
  ): Promise<boolean> {
    try {
      // Older test doubles of the registry stub only `sync`; a missing read
      // is the same as a disabled registry — nothing to adopt.
      if (
        typeof this.issuerRegistryService.readIssuerAssurance !== "function"
      ) {
        return false;
      }
      const assurance =
        await this.issuerRegistryService.readIssuerAssurance(issuerId);
      if (assurance.state !== "found") {
        this.logger.warn(
          `Issuer assurance not refreshed for ${issuerId}: registry read ${assurance.state}`,
        );
        return false;
      }
      await this.prisma.issuer.update({
        where: { id: issuerId },
        data: {
          assuranceLevel: assurance.assuranceLevel,
          accreditationExpiresAt: assurance.accreditationExpiresAt,
          accreditationSyncedAt: assurance.observedAt,
          accreditationContractId: assurance.contractId,
          accreditationTransactionHash: transactionHash,
        },
      });
      return true;
    } catch (error) {
      this.logger.warn(
        `Issuer assurance refresh failed for ${issuerId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  private allowlistedMetadata(metadata: unknown): Record<string, string> {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return {};
    }
    // Allowlist only: assurance and accreditation are contract-backed facts
    // and are never accepted from tenant metadata, so keys such as
    // `assuranceLevel` or `accreditationExpiresAt` in publicMetadata are
    // dropped here rather than stored.
    const source = metadata as Record<string, unknown>;
    return Object.fromEntries(
      ["name", "description", "logoUrl"]
        .filter((key) => typeof source[key] === "string")
        .map((key) => [key, source[key] as string]),
    );
  }

  private hashMetadata(metadata: Record<string, any>): string {
    const json = JSON.stringify(metadata);
    return createHash("sha256").update(json).digest("hex");
  }

  private isValidStellarAddress(address: string): boolean {
    // Basic Stellar public key validation (G prefix and 56 characters)
    return /^G[A-Z2-7]{55}$/.test(address);
  }

  private toResponseDto(issuer: any, now: Date = new Date()): IssuerResponseDto {
    return {
      id: issuer.id,
      organizationId: issuer.organizationId,
      stellarAddress: issuer.stellarAddress,
      status: issuer.status,
      revision: issuer.revision,
      assuranceLevel:
        issuer.assuranceLevel ?? IssuerAssuranceLevel.NONE,
      accreditationExpiresAt: issuer.accreditationExpiresAt ?? null,
      accreditationSyncedAt: issuer.accreditationSyncedAt ?? null,
      accreditationContractId: issuer.accreditationContractId ?? null,
      accreditationTransactionHash:
        issuer.accreditationTransactionHash ?? null,
      effectiveAccreditationStatus: computeEffectiveAccreditationStatus(
        issuer,
        now,
        DEFAULT_ACCREDITATION_CLOCK_SKEW_MS,
      ),
      accreditationStale: isAccreditationStale(
        issuer,
        now,
        DEFAULT_ACCREDITATION_CLOCK_SKEW_MS,
        DEFAULT_ACCREDITATION_MAX_AGE_MS,
      ),
      metadataHash: issuer.metadataHash,
      publicMetadata: this.allowlistedMetadata(issuer.publicMetadata),
      contractSyncState: issuer.contractSyncState,
      contractTransactionHash: issuer.contractTransactionHash,
      contractSyncedAt: issuer.contractSyncedAt,
      verifiedAt: issuer.verifiedAt,
      suspendedAt: issuer.suspendedAt,
      revokedAt: issuer.revokedAt,
      createdAt: issuer.createdAt,
      updatedAt: issuer.updatedAt,
    };
  }

  /**
   * Public view of an issuer. Only allowlisted metadata is exposed, and the
   * provenance detail (which contract was read, and the establishing
   * transaction) stays admin-only; the accreditation itself — level, expiry,
   * effective status, staleness — is public, queryable state.
   */
  private toPublicResponseDto(
    issuer: any,
    now: Date = new Date(),
  ): IssuerPublicResponseDto {
    return {
      id: issuer.id,
      stellarAddress: issuer.stellarAddress,
      trustStatus: this.computeTrustStatus(issuer),
      assuranceLevel:
        issuer.assuranceLevel ?? IssuerAssuranceLevel.NONE,
      accreditationExpiresAt: issuer.accreditationExpiresAt ?? null,
      effectiveAccreditationStatus: computeEffectiveAccreditationStatus(
        issuer,
        now,
        DEFAULT_ACCREDITATION_CLOCK_SKEW_MS,
      ),
      accreditationStale: isAccreditationStale(
        issuer,
        now,
        DEFAULT_ACCREDITATION_CLOCK_SKEW_MS,
        DEFAULT_ACCREDITATION_MAX_AGE_MS,
      ),
      publicMetadata: this.allowlistedMetadata(issuer.publicMetadata),
      createdAt: issuer.createdAt,
    };
  }

  private createAuditLog(
    user: AuthenticatedUser,
    action: string,
    resourceType: string,
    resourceId: string,
    metadata: any,
  ) {
    return this.prisma.auditLog.create({
      data: {
        actorId: user.id,
        actorType: "User",
        action,
        resourceType,
        resourceId,
        metadata,
        createdAt: new Date(),
      },
    });
  }
}

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ApprovalRequest, ApprovalRequestStatus, Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import {
  CURRENT_PAYLOAD_HASH_VERSION,
  SUPPORTED_PAYLOAD_HASH_VERSIONS,
  RequestBodyTooLargeError,
  UncanonicalizableRequestBodyError,
  UnsupportedPayloadHashVersionError,
  hashRequestBody,
  verifyRequestBodyHash,
} from "../common/crypto/request-body-hash";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../database/prisma.service";
import { CreateApprovalRequestDto } from "./dto/create-approval-request.dto";
import { DecideApprovalRequestDto } from "./dto/decide-approval-request.dto";

const DEFAULT_TTL_MINUTES = 1440;

export type LeaseClaimResult =
  | { claimed: true; leaseToken: string }
  | { claimed: false; request: ApprovalRequest };

@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(
    user: AuthenticatedUser,
    dto: CreateApprovalRequestDto,
  ): Promise<ApprovalRequest> {
    // Versioned hash of the reviewed payload. Secret-bearing keys are
    // stripped before hashing, so the hash can neither leak a secret nor be
    // used to brute-force a low-entropy one; the stripped key paths are
    // recorded in the audit entry so the redaction is observable.
    // Oversized or uncanonicalizable payloads are a client error, not a
    // server error.
    let hashed;
    try {
      hashed = hashRequestBody(dto.payload);
    } catch (error) {
      if (
        error instanceof RequestBodyTooLargeError ||
        error instanceof UncanonicalizableRequestBodyError
      ) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
    const payloadHash = hashed.hash;
    const ttlMinutes = dto.ttlMinutes ?? DEFAULT_TTL_MINUTES;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

    const request = await this.prisma.approvalRequest.create({
      data: {
        operationType: dto.operationType,
        payload: dto.payload as Prisma.InputJsonValue,
        payloadHash,
        payloadHashVersion: hashed.version,
        requestedById: user.id,
        expiresAt,
      },
    });

    await this.audit(user, "approval.requested", request.id, {
      operationType: dto.operationType,
      payloadHash,
      payloadHashVersion: hashed.version,
      redactedKeys: hashed.redactedKeys,
      expiresAt,
    });

    return request;
  }

  async get(id: string): Promise<ApprovalRequest> {
    const request = await this.prisma.approvalRequest.findUnique({ where: { id } });
    if (!request) {
      throw new NotFoundException(`Approval request ${id} not found`);
    }
    return request;
  }

  /**
   * Approve a pending request.
   *
   * Self-approval is blocked unconditionally. The transition out of PENDING
   * is applied with a single conditional `updateMany` so that under
   * concurrent decisions exactly one caller observes `count === 1` — the
   * other(s) land on the now-terminal state and are told so, never silently
   * overwriting a decision that already won.
   */
  async approve(
    user: AuthenticatedUser,
    id: string,
    dto: DecideApprovalRequestDto,
  ): Promise<ApprovalRequest> {
    return this.decide(user, id, dto, "APPROVED");
  }

  /** Reject a pending request. Same terminal-decision guarantees as {@link approve}. */
  async reject(
    user: AuthenticatedUser,
    id: string,
    dto: DecideApprovalRequestDto,
  ): Promise<ApprovalRequest> {
    return this.decide(user, id, dto, "REJECTED");
  }

  private async decide(
    user: AuthenticatedUser,
    id: string,
    dto: DecideApprovalRequestDto,
    outcome: "APPROVED" | "REJECTED",
  ): Promise<ApprovalRequest> {
    const existing = await this.get(id);

    if (existing.requestedById === user.id) {
      throw new ForbiddenException(
        "The requester of a privileged operation cannot decide on it",
      );
    }

    // Fail closed on a hash version this code does not know: an
    // unrecognized version must never be treated as a match.
    this.assertSupportedPayloadHashVersion(existing);

    if (existing.payloadHash !== dto.expectedPayloadHash) {
      throw new ConflictException(
        "expectedPayloadHash does not match the request's current payload — refresh and retry",
      );
    }

    const now = new Date();

    const result = await this.prisma.approvalRequest.updateMany({
      where: {
        id,
        status: ApprovalRequestStatus.PENDING,
        // Boundary: a request expiring at exactly `now` is treated as
        // already expired, matching the expiry sweep's own `lt` cutoff.
        expiresAt: { gt: now },
      },
      data: {
        status: outcome,
        decidedById: user.id,
        decidedAt: now,
        decisionReason: dto.reason,
      },
    });

    if (result.count === 0) {
      const current = await this.get(id);
      if (current.status !== ApprovalRequestStatus.PENDING) {
        throw new ConflictException(
          `Request already has a terminal decision: ${current.status}`,
        );
      }
      // Status is still PENDING in the row we just re-read, so the only
      // other reason the conditional update missed is the expiry boundary.
      throw new ConflictException("Request has expired and can no longer be decided");
    }

    const updated = await this.get(id);

    await this.audit(user, `approval.${outcome.toLowerCase()}`, id, {
      reason: dto.reason,
      payloadHash: existing.payloadHash,
      payloadHashVersion: existing.payloadHashVersion,
    });

    return updated;
  }

  /** Requester or an admin may cancel a request that is still PENDING. */
  async cancel(user: AuthenticatedUser, id: string): Promise<ApprovalRequest> {
    const existing = await this.get(id);

    if (existing.requestedById !== user.id && user.role !== "ADMIN") {
      throw new ForbiddenException(
        "Only the requester or an admin may cancel this request",
      );
    }

    const result = await this.prisma.approvalRequest.updateMany({
      where: { id, status: ApprovalRequestStatus.PENDING },
      data: {
        status: ApprovalRequestStatus.CANCELLED,
        decidedById: user.id,
        decidedAt: new Date(),
      },
    });

    if (result.count === 0) {
      const current = await this.get(id);
      throw new ConflictException(
        `Request already has a terminal decision: ${current.status}`,
      );
    }

    const updated = await this.get(id);
    await this.audit(user, "approval.cancelled", id, {
      payloadHash: existing.payloadHash,
      payloadHashVersion: existing.payloadHashVersion,
    });
    return updated;
  }

  /**
   * Atomically claim the right to execute an APPROVED request exactly once.
   *
   * Only one concurrent caller will see `claimed: true`; every other caller
   * (including retries after the lease is already held) sees `claimed: false`
   * with the current row so it can decide whether to wait, no-op, or report
   * the conflict upward.
   *
   * Before the lease is granted, the stored payload is re-hashed and
   * compared with the hash the approver reviewed. This binds execution to
   * the approved payload: if the stored payload was altered after the
   * decision, the claim is refused instead of executing a payload nobody
   * approved. Rows approved before secret redaction existed are still
   * accepted via their legacy unredacted hash.
   */
  async claimForExecution(id: string): Promise<LeaseClaimResult> {
    const request = await this.get(id);

    if (request.status !== ApprovalRequestStatus.APPROVED) {
      return { claimed: false, request };
    }

    this.assertStoredPayloadMatches(request);

    const leaseToken = randomUUID();

    const result = await this.prisma.approvalRequest.updateMany({
      where: {
        id,
        status: ApprovalRequestStatus.APPROVED,
        executionLeaseToken: null,
      },
      data: {
        executionLeaseToken: leaseToken,
        executionLeasedAt: new Date(),
      },
    });

    if (result.count === 1) {
      return { claimed: true, leaseToken };
    }

    return { claimed: false, request: await this.get(id) };
  }

  /**
   * Mark execution complete for the lease obtained from
   * {@link claimForExecution}. Idempotent: calling it again with the same
   * lease token after it already completed is a no-op, not an error.
   *
   * The transition is recorded in the audit trail (`approval.executed`)
   * with the versioned payload hash, so the audit evidence covers the
   * whole chain: request → decision → execution, all bound to the same
   * hash. The audit write is awaited and fail-closed like the other audit
   * writes in this service; the idempotent repeat path writes nothing,
   * because the first call already recorded the event.
   */
  async completeExecution(id: string, leaseToken: string): Promise<ApprovalRequest> {
    const now = new Date();

    const result = await this.prisma.approvalRequest.updateMany({
      where: {
        id,
        executionLeaseToken: leaseToken,
        status: ApprovalRequestStatus.APPROVED,
      },
      data: {
        status: ApprovalRequestStatus.EXECUTED,
        executedAt: now,
      },
    });

    const current = await this.get(id);

    if (result.count === 0) {
      const alreadyCompletedByThisLease =
        current.status === ApprovalRequestStatus.EXECUTED &&
        current.executionLeaseToken === leaseToken;

      if (!alreadyCompletedByThisLease) {
        throw new ConflictException(
          "Execution lease mismatch — this caller does not hold the active lease",
        );
      }
    } else {
      await this.prisma.auditLog.create({
        data: {
          actorId: null,
          actorType: "System",
          action: "approval.executed",
          resourceType: "ApprovalRequest",
          resourceId: id,
          metadata: {
            payloadHash: current.payloadHash,
            payloadHashVersion: current.payloadHashVersion,
          } as Prisma.InputJsonValue,
        },
      });
    }

    return current;
  }

  /** Expire PENDING requests whose deadline has passed. Returns the count affected. */
  async expireStale(): Promise<number> {
    const result = await this.prisma.approvalRequest.updateMany({
      where: {
        status: ApprovalRequestStatus.PENDING,
        expiresAt: { lt: new Date() },
      },
      data: { status: ApprovalRequestStatus.EXPIRED },
    });
    return result.count;
  }

  /**
   * Fail closed when a stored request carries a payload-hash version this
   * code does not know. Rows predating versioning carry the default (1).
   */
  private assertSupportedPayloadHashVersion(request: ApprovalRequest): void {
    const version = request.payloadHashVersion ?? CURRENT_PAYLOAD_HASH_VERSION;
    if (!SUPPORTED_PAYLOAD_HASH_VERSIONS.includes(version)) {
      throw new ConflictException(
        `Unsupported payload hash version ${version} — request cannot be decided`,
      );
    }
  }

  /**
   * Recompute the versioned hash over a stored request's payload and fail
   * closed when it no longer matches the hash recorded at request time.
   * Unknown versions fail closed; rows approved before secret redaction
   * existed are accepted via their legacy unredacted hash.
   */
  private assertStoredPayloadMatches(request: ApprovalRequest): void {
    try {
      const matches = verifyRequestBodyHash(request, request.payload, {
        allowLegacyUnredacted: true,
      });
      if (!matches) {
        throw new ConflictException(
          "Stored payload no longer matches the approved payload hash — execution refused",
        );
      }
    } catch (error) {
      if (error instanceof UnsupportedPayloadHashVersionError) {
        throw new ConflictException(
          `Unsupported payload hash version ${request.payloadHashVersion} — execution refused`,
        );
      }
      throw error;
    }
  }

  private audit(
    user: AuthenticatedUser,
    action: string,
    resourceId: string,
    metadata: Record<string, unknown>,
  ) {
    return this.prisma.auditLog.create({
      data: {
        actorId: user.id,
        actorType: "User",
        action,
        resourceType: "ApprovalRequest",
        resourceId,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }
}

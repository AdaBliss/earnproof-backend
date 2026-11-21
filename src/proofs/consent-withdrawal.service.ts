import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ConsentWithdrawalStatus } from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";
import { canonicalize } from "../common/crypto/canonicalize";
import { sha256 } from "../common/crypto/hash";
import { isUniqueViolation } from "../contracts/event-projection";
import { PrismaService } from "../database/prisma.service";
import { ContractAnchoringService } from "./contract-anchoring.service";

/** Contract submission attempts before a withdrawal is marked FAILED. */
export const MAX_WITHDRAWAL_ATTEMPTS = 5;
/** Minimum spacing between submission attempts for one withdrawal. */
export const WITHDRAWAL_RETRY_COOLDOWN_MS = 30_000;
/** Most withdrawals one reconciliation pass touches. */
export const MAX_RECONCILE_BATCH = 25;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export type WithdrawalIneligibleReason =
  | "RECEIPT_EXPIRED"
  | "WITHDRAWAL_IN_PROGRESS"
  | "WITHDRAWAL_FAILED"
  | "ALREADY_WITHDRAWN";

export interface WithdrawalEligibilityDto {
  disclosureReceiptId: string;
  eligible: boolean;
  reason: WithdrawalIneligibleReason | null;
  withdrawalId: string | null;
}

export interface ConsentWithdrawalDto {
  id: string;
  disclosureReceiptId: string;
  status: ConsentWithdrawalStatus;
  attemptCount: number;
  maxAttempts: number;
  failureCode: string | null;
  requestedAt: string;
  confirmedAt: string | null;
}

export interface ConsentWithdrawalReceiptDto {
  withdrawalId: string;
  disclosureReceiptId: string;
  status: "CONFIRMED";
  withdrawalCommitment: string;
  transactionHash: string;
  confirmedAt: string;
  /** Always false: nothing is deleted by a withdrawal. */
  recordsDeleted: false;
  statement: string;
}

type WithdrawalRow = {
  id: string;
  subjectUserId: string;
  disclosureReceiptId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  withdrawalCommitment: string;
  status: ConsentWithdrawalStatus;
  attemptCount: number;
  transactionHash: string | null;
  failureCode: string | null;
  requestedAt: Date;
  lastAttemptAt: Date | null;
  confirmedAt: Date | null;
};

@Injectable()
export class ConsentWithdrawalService {
  private readonly logger = new Logger(ConsentWithdrawalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly contract: ContractAnchoringService,
  ) {}

  async getEligibility(
    user: AuthenticatedUser,
    disclosureReceiptId: string,
    now: Date = new Date(),
  ): Promise<WithdrawalEligibilityDto> {
    const receipt = await this.loadOwnedReceipt(user, disclosureReceiptId);
    const existing = await this.prisma.consentWithdrawal.findUnique({
      where: { disclosureReceiptId },
    });
    return this.eligibilityFor(receipt, existing, now);
  }

  /**
   * Accepts a withdrawal request. Idempotent on (subject, key): replaying the
   * same request returns the same withdrawal; reusing the key for a different
   * request is rejected.
   */
  async requestWithdrawal(
    user: AuthenticatedUser,
    disclosureReceiptId: string,
    idempotencyKey: string | undefined,
    now: Date = new Date(),
  ): Promise<ConsentWithdrawalDto> {
    if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new BadRequestException(
        "Idempotency-Key header is required (16-64 characters: letters, digits, '_' or '-').",
      );
    }

    const receipt = await this.loadOwnedReceipt(user, disclosureReceiptId);
    const requestFingerprint = sha256(
      canonicalize({ disclosureReceiptId, subjectUserId: user.id }),
    );

    const replay = await this.prisma.consentWithdrawal.findUnique({
      where: {
        subjectUserId_idempotencyKey: {
          subjectUserId: user.id,
          idempotencyKey,
        },
      },
    });
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new UnprocessableEntityException(
          "Idempotency-Key was already used for a different request.",
        );
      }
      return toDto(replay);
    }

    const existing = await this.prisma.consentWithdrawal.findUnique({
      where: { disclosureReceiptId },
    });
    const eligibility = this.eligibilityFor(receipt, existing, now);
    if (!eligibility.eligible) {
      throw new ConflictException(
        `Consent withdrawal is not available: ${eligibility.reason}`,
      );
    }

    let created: WithdrawalRow;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const row = await tx.consentWithdrawal.create({
          data: {
            subjectUserId: user.id,
            disclosureReceiptId,
            organizationId: receipt.organizationId,
            idempotencyKey,
            requestFingerprint,
            withdrawalCommitment: sha256(
              canonicalize({
                purpose: "consent-withdrawal",
                disclosureReceiptId,
                subjectUserId: user.id,
              }),
            ),
            requestedAt: now,
          },
        });
        // The audit row commits with the request: an unrecorded withdrawal
        // must not exist. Only ids are recorded, never receipt contents.
        await tx.auditLog.create({
          data: {
            actorType: "user",
            actorId: user.id,
            action: "proof.consent_withdrawal_requested",
            resourceType: "disclosure_receipt",
            resourceId: disclosureReceiptId,
            metadata: { withdrawalId: row.id },
          },
        });
        return row;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent request won the race; surface its result.
      const winner = await this.prisma.consentWithdrawal.findUnique({
        where: { disclosureReceiptId },
      });
      if (winner?.subjectUserId === user.id && winner.idempotencyKey === idempotencyKey) {
        return toDto(winner);
      }
      throw new ConflictException(
        "Consent withdrawal is not available: WITHDRAWAL_IN_PROGRESS",
      );
    }

    const attempted = await this.attemptSubmission(created, now);
    return toDto(attempted ?? created);
  }

  async getWithdrawal(
    user: AuthenticatedUser,
    withdrawalId: string,
  ): Promise<ConsentWithdrawalDto> {
    return toDto(await this.loadOwnedWithdrawal(user, withdrawalId));
  }

  /**
   * Reconciles one withdrawal on the subject's behalf: retries a pending (or
   * failed) submission, subject to the attempt cooldown.
   */
  async reconcileWithdrawal(
    user: AuthenticatedUser,
    withdrawalId: string,
    now: Date = new Date(),
  ): Promise<ConsentWithdrawalDto> {
    const row = await this.loadOwnedWithdrawal(user, withdrawalId);
    if (row.status === ConsentWithdrawalStatus.CONFIRMED) return toDto(row);

    if (row.status === ConsentWithdrawalStatus.FAILED) {
      // A manual retry re-arms a failed withdrawal, still gated by the cooldown.
      const reopened = await this.prisma.consentWithdrawal.updateMany({
        where: {
          id: row.id,
          status: ConsentWithdrawalStatus.FAILED,
          OR: [
            { lastAttemptAt: null },
            { lastAttemptAt: { lt: new Date(now.getTime() - WITHDRAWAL_RETRY_COOLDOWN_MS) } },
          ],
        },
        data: {
          status: ConsentWithdrawalStatus.PENDING,
          attemptCount: 0,
          failureCode: null,
          lastAttemptAt: null,
        },
      });
      if (reopened.count === 0) return toDto(row);
    }

    const fresh = await this.loadOwnedWithdrawal(user, withdrawalId);
    const attempted = await this.attemptSubmission(fresh, now);
    return toDto(attempted ?? fresh);
  }

  /** The receipt for a confirmed withdrawal. */
  async getReceipt(
    user: AuthenticatedUser,
    withdrawalId: string,
  ): Promise<ConsentWithdrawalReceiptDto> {
    const row = await this.loadOwnedWithdrawal(user, withdrawalId);
    if (
      row.status !== ConsentWithdrawalStatus.CONFIRMED ||
      !row.transactionHash ||
      !row.confirmedAt
    ) {
      throw new ConflictException("The withdrawal is not confirmed yet.");
    }
    return {
      withdrawalId: row.id,
      disclosureReceiptId: row.disclosureReceiptId,
      status: "CONFIRMED",
      withdrawalCommitment: row.withdrawalCommitment,
      transactionHash: row.transactionHash,
      confirmedAt: row.confirmedAt.toISOString(),
      recordsDeleted: false,
      statement:
        "This receipt records that the subject withdrew consent. Records that were already " +
        "issued or anchored are immutable and are not deleted.",
    };
  }

  /**
   * Retries pending withdrawals whose cooldown has elapsed. Bounded: at most
   * {@link MAX_RECONCILE_BATCH} rows per pass, oldest attempt first.
   */
  async reconcilePending(now: Date = new Date()): Promise<{ attempted: number; confirmed: number }> {
    const due = await this.prisma.consentWithdrawal.findMany({
      where: {
        status: ConsentWithdrawalStatus.PENDING,
        attemptCount: { lt: MAX_WITHDRAWAL_ATTEMPTS },
        OR: [
          { lastAttemptAt: null },
          { lastAttemptAt: { lt: new Date(now.getTime() - WITHDRAWAL_RETRY_COOLDOWN_MS) } },
        ],
      },
      orderBy: [{ lastAttemptAt: "asc" }, { id: "asc" }],
      take: MAX_RECONCILE_BATCH,
    });

    let attempted = 0;
    let confirmed = 0;
    for (const row of due) {
      const result = await this.attemptSubmission(row, now);
      if (!result) continue;
      attempted += 1;
      if (result.status === ConsentWithdrawalStatus.CONFIRMED) confirmed += 1;
    }
    return { attempted, confirmed };
  }

  /**
   * One contract submission. The claim is a conditional update on the cooldown
   * so two workers (or a worker and a client) cannot submit concurrently.
   *
   * @returns the updated row, or null when another caller holds the claim.
   */
  private async attemptSubmission(
    row: WithdrawalRow,
    now: Date,
  ): Promise<WithdrawalRow | null> {
    if (row.status !== ConsentWithdrawalStatus.PENDING) return row;

    const claimed = await this.prisma.consentWithdrawal.updateMany({
      where: {
        id: row.id,
        status: ConsentWithdrawalStatus.PENDING,
        OR: [
          { lastAttemptAt: null },
          { lastAttemptAt: { lt: new Date(now.getTime() - WITHDRAWAL_RETRY_COOLDOWN_MS) } },
        ],
      },
      data: { lastAttemptAt: now },
    });
    if (claimed.count === 0) return null;

    let outcome: Awaited<ReturnType<ContractAnchoringService["withdrawDisclosureConsent"]>>;
    try {
      outcome = await this.contract.withdrawDisclosureConsent({
        disclosureReceiptId: row.disclosureReceiptId,
        withdrawalCommitment: row.withdrawalCommitment,
      });
    } catch {
      // Raw errors can carry RPC detail; only a stable code is kept.
      outcome = { anchored: false, reason: "failed", error: "CONTRACT_ERROR" };
    }

    if (outcome.anchored) {
      return this.prisma.consentWithdrawal.update({
        where: { id: row.id },
        data: {
          status: ConsentWithdrawalStatus.CONFIRMED,
          transactionHash: outcome.transactionHash,
          confirmedAt: now,
          attemptCount: { increment: 1 },
          failureCode: null,
        },
      });
    }

    // Disabled, busy, open-circuit and fee-refused outcomes never reached the
    // contract, so they neither burn an attempt nor fail the withdrawal.
    if (outcome.reason !== "failed") {
      return this.prisma.consentWithdrawal.update({
        where: { id: row.id },
        data: { failureCode: outcome.reason.toUpperCase() },
      });
    }

    const attempts = row.attemptCount + 1;
    const permanent = outcome.failureKind === "permanent";
    const exhausted = attempts >= MAX_WITHDRAWAL_ATTEMPTS;
    this.logger.warn(
      `Consent withdrawal ${row.id} submission failed (attempt ${attempts}, permanent=${permanent})`,
    );
    return this.prisma.consentWithdrawal.update({
      where: { id: row.id },
      data: {
        attemptCount: attempts,
        status:
          permanent || exhausted
            ? ConsentWithdrawalStatus.FAILED
            : ConsentWithdrawalStatus.PENDING,
        failureCode: permanent ? "CONTRACT_REJECTED" : "CONTRACT_UNAVAILABLE",
      },
    });
  }

  private eligibilityFor(
    receipt: { id: string; expiresAt: Date },
    existing: { id: string; status: ConsentWithdrawalStatus } | null,
    now: Date,
  ): WithdrawalEligibilityDto {
    const base = { disclosureReceiptId: receipt.id, withdrawalId: existing?.id ?? null };
    if (existing?.status === ConsentWithdrawalStatus.CONFIRMED) {
      return { ...base, eligible: false, reason: "ALREADY_WITHDRAWN" };
    }
    if (existing?.status === ConsentWithdrawalStatus.FAILED) {
      // Retry through reconcile; a new request would only create a duplicate.
      return { ...base, eligible: false, reason: "WITHDRAWAL_FAILED" };
    }
    if (existing) {
      return { ...base, eligible: false, reason: "WITHDRAWAL_IN_PROGRESS" };
    }
    if (receipt.expiresAt.getTime() <= now.getTime()) {
      return { ...base, eligible: false, reason: "RECEIPT_EXPIRED" };
    }
    return { ...base, eligible: true, reason: null };
  }

  /** Unknown receipts and receipts for another subject are indistinguishable. */
  private async loadOwnedReceipt(user: AuthenticatedUser, disclosureReceiptId: string) {
    const receipt = await this.prisma.disclosureReceipt.findUnique({
      where: { id: disclosureReceiptId },
      select: {
        id: true,
        organizationId: true,
        expiresAt: true,
        proof: { select: { userId: true } },
      },
    });
    if (!receipt || receipt.proof.userId !== user.id) {
      throw new NotFoundException("Disclosure receipt not found");
    }
    return receipt;
  }

  private async loadOwnedWithdrawal(user: AuthenticatedUser, withdrawalId: string) {
    const row = await this.prisma.consentWithdrawal.findUnique({
      where: { id: withdrawalId },
    });
    if (!row || row.subjectUserId !== user.id) {
      throw new NotFoundException("Consent withdrawal not found");
    }
    return row;
  }
}

function toDto(row: WithdrawalRow): ConsentWithdrawalDto {
  return {
    id: row.id,
    disclosureReceiptId: row.disclosureReceiptId,
    status: row.status,
    attemptCount: row.attemptCount,
    maxAttempts: MAX_WITHDRAWAL_ATTEMPTS,
    failureCode: row.failureCode,
    requestedAt: row.requestedAt.toISOString(),
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
  };
}

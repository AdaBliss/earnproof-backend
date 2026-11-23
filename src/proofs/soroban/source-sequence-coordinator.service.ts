import { randomUUID } from "crypto";
import * as os from "os";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { sha256 } from "../../common/crypto/hash";
import { StructuredLogger } from "../../common/logger";
import { PrismaService } from "../../database/prisma.service";
import { SequenceCoordinatorPort, SequenceLease } from "./ports";

export type { SequenceLease } from "./ports";

/**
 * Lease TTL. It must exceed the longest single transaction attempt (the CLI
 * call is capped at 120s) so a healthy holder is never taken over mid-submit.
 */
export const DEFAULT_SEQUENCE_LEASE_TTL_MS = 150_000;

export type LeaseOutcome<T> =
  | { acquired: true; value: T }
  | { acquired: false };

/** Prisma's unique-constraint violation, the loser's signal in a create race. */
const UNIQUE_VIOLATION = "P2002";

/**
 * Serialises transaction construction per Stellar source account.
 *
 * Two workers that build a transaction for the same source account read the
 * same sequence number, and the second to submit gets `tx_bad_seq`. Rather
 * than guess sequences, this boundary guarantees that at most one holder at a
 * time owns an account, so each submission observes the sequence left by the
 * previous one.
 *
 * - Acquisition is a single `INSERT` (unique per account) or, for an expired
 *   row, a single conditional `UPDATE`; exactly one concurrent caller wins.
 * - A lease that is not renewed expires, and the next caller takes it over.
 *   That is the explicit stale-allocation recovery: a crashed worker cannot
 *   block the account for longer than the TTL.
 * - A holder must `renew` immediately before submitting. Renewal succeeds only
 *   while the caller still owns an unexpired lease, so a worker that stalled
 *   past its TTL and was taken over finds out before it can submit.
 */
@Injectable()
export class SourceSequenceCoordinator extends SequenceCoordinatorPort {
  private readonly logger = new StructuredLogger(SourceSequenceCoordinator.name);
  private readonly ttlMs: number;
  private readonly holderId = `${os.hostname()}-${process.pid}`;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    super();
    this.ttlMs =
      config.get<number>("contractAnchoring.sequenceLease.ttlMs") ??
      DEFAULT_SEQUENCE_LEASE_TTL_MS;
  }

  /** Stable, non-reversible key for a source. The source may be a secret. */
  static accountKeyFor(source: string): string {
    return sha256(`stellar-source:${source}`);
  }

  /** @returns the lease, or `null` when another holder owns the account. */
  async acquire(source: string): Promise<SequenceLease | null> {
    const accountKey = SourceSequenceCoordinator.accountKeyFor(source);
    const token = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlMs);

    try {
      const row = await this.prisma.sourceAccountSequenceLease.create({
        data: { accountKey, holderToken: token, holderId: this.holderId, expiresAt },
      });
      return { accountKey, token, fencingCounter: row.fencingCounter, expiresAt };
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== UNIQUE_VIOLATION
      ) {
        throw error;
      }
    }

    // A row exists. Take it over only if it has expired; the predicate is part
    // of the UPDATE, so of N racing takers exactly one matches.
    const takeover = await this.prisma.sourceAccountSequenceLease.updateMany({
      where: { accountKey, expiresAt: { lt: now } },
      data: {
        holderToken: token,
        holderId: this.holderId,
        expiresAt,
        fencingCounter: { increment: 1 },
      },
    });
    if (takeover.count !== 1) return null;

    const row = await this.prisma.sourceAccountSequenceLease.findUnique({
      where: { accountKey },
    });
    if (!row || row.holderToken !== token) return null;

    this.logger.warn(
      `Recovered expired source-account lease (fencing=${row.fencingCounter})`,
    );
    return { accountKey, token, fencingCounter: row.fencingCounter, expiresAt };
  }

  /**
   * Extends a lease the caller still holds.
   *
   * @returns `false` if the lease expired or was taken over: the caller must
   *          not submit.
   */
  async renew(lease: SequenceLease): Promise<boolean> {
    const now = new Date();
    const result = await this.prisma.sourceAccountSequenceLease.updateMany({
      where: {
        accountKey: lease.accountKey,
        holderToken: lease.token,
        expiresAt: { gte: now },
      },
      data: { expiresAt: new Date(now.getTime() + this.ttlMs) },
    });
    return result.count === 1;
  }

  async release(lease: SequenceLease): Promise<void> {
    try {
      await this.prisma.sourceAccountSequenceLease.deleteMany({
        where: { accountKey: lease.accountKey, holderToken: lease.token },
      });
    } catch {
      // The lease expires on its own; a failed release only delays the next
      // holder by at most the TTL and must not fail the operation.
      this.logger.warn("Failed to release source-account lease; it will expire");
    }
  }

  /** Runs `fn` while holding the account, releasing the lease afterwards. */
  async withLease<T>(
    source: string,
    fn: (lease: SequenceLease) => Promise<T>,
  ): Promise<LeaseOutcome<T>> {
    const lease = await this.acquire(source);
    if (!lease) return { acquired: false };
    try {
      return { acquired: true, value: await fn(lease) };
    } finally {
      await this.release(lease);
    }
  }
}

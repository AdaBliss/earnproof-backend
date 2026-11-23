import { Injectable } from "@nestjs/common";
import { ContractEventGapStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";

/**
 * Detects missing contract-event ledger ranges and backfills them without
 * blocking live ingestion.
 *
 * Live ingestion reports each range it has processed via {@link observeLiveRange}.
 * A jump past the highest ledger seen so far is a gap, recorded durably as a
 * `ContractEventGap` row. Backfill ({@link runBackfill}) claims gaps, reads a
 * bounded chunk at a time, and shrinks the gap to what remains, so a crash or a
 * restart resumes where it stopped.
 *
 * Live and backfill can both see the same event. Neither applies an event
 * directly: both go through {@link applyEventOnce}, whose `ContractEventApplied`
 * primary key admits an event exactly once.
 */

export interface ContractEventRecord {
  /** Stable, unique id of the event within the stream. */
  readonly id: string;
  readonly ledger: number;
}

export type ContractEventPage =
  | {
      readonly kind: "events";
      readonly events: readonly ContractEventRecord[];
      /**
       * The source guarantees it returned every event up to and including this
       * ledger. May be below the requested end when the page was truncated.
       */
      readonly coveredThroughLedger: number;
    }
  | {
      readonly kind: "unavailable";
      /** Oldest ledger the provider still retains. */
      readonly oldestAvailableLedger: number;
    };

export interface ContractEventSource {
  fetchEvents(
    streamKey: string,
    fromLedger: number,
    toLedger: number,
  ): Promise<ContractEventPage>;
}

export type ContractEventHandler = (
  event: ContractEventRecord,
  tx: Prisma.TransactionClient,
) => Promise<void>;

export interface BackfillOptions {
  /** Most ledgers read in one chunk. */
  readonly maxLedgersPerChunk: number;
  /** Most chunks one run may process, bounding its total work. */
  readonly maxChunksPerRun: number;
  /** Consecutive failures after which a range is declared irrecoverable. */
  readonly maxAttempts: number;
  /** A BACKFILLING claim older than this is considered abandoned. */
  readonly claimLeaseMs: number;
}

export const DEFAULT_BACKFILL_OPTIONS: BackfillOptions = {
  maxLedgersPerChunk: 500,
  maxChunksPerRun: 5,
  maxAttempts: 5,
  claimLeaseMs: 10 * 60_000,
};

export interface BackfillSummary {
  chunksProcessed: number;
  eventsApplied: number;
  eventsSkippedAsDuplicate: number;
  gapsResolved: number;
  gapsIrrecoverable: number;
}

export interface GapView {
  readonly id: string;
  readonly streamKey: string;
  readonly fromLedger: number;
  readonly toLedger: number;
  readonly status: ContractEventGapStatus;
  readonly attempts: number;
  readonly failureReason: string | null;
}

const OPEN: ContractEventGapStatus[] = ["DETECTED", "BACKFILLING"];
const MAX_OBSERVE_RETRIES = 5;

function assertLedgerRange(from: number, to: number): void {
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    from > to
  ) {
    throw new RangeError("Invalid ledger range");
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

@Injectable()
export class ContractEventGapService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records that live ingestion processed ledgers `[fromLedger, toLedger]`.
   *
   * - A range starting beyond `highestSeen + 1` records the skipped ledgers as
   *   a gap.
   * - A range overlapping what was already seen is accepted; it shrinks or
   *   resolves any open gap it covers, so late live delivery fills gaps too.
   * - The first range ever seen for a stream establishes the baseline: nothing
   *   earlier is known to be missing.
   *
   * Safe to call concurrently and repeatedly with the same range.
   *
   * @returns the number of new gaps recorded
   */
  async observeLiveRange(
    streamKey: string,
    fromLedger: number,
    toLedger: number,
  ): Promise<number> {
    assertLedgerRange(fromLedger, toLedger);

    for (let attempt = 0; attempt < MAX_OBSERVE_RETRIES; attempt += 1) {
      try {
        const detected = await this.prisma.$transaction(async (tx) => {
          const cursor = await tx.contractEventCursor.findUnique({
            where: { streamKey },
          });

          if (!cursor) {
            await tx.contractEventCursor.create({
              data: { streamKey, highestSeenLedger: toLedger },
            });
            return 0;
          }

          let newGaps = 0;
          if (fromLedger > cursor.highestSeenLedger + 1) {
            newGaps = await this.recordGap(
              tx,
              streamKey,
              cursor.highestSeenLedger + 1,
              fromLedger - 1,
            );
          }
          if (fromLedger <= cursor.highestSeenLedger) {
            await this.coverRange(tx, streamKey, fromLedger, toLedger);
          }

          const advanced = await tx.contractEventCursor.updateMany({
            where: { streamKey, version: cursor.version },
            data: {
              highestSeenLedger: Math.max(cursor.highestSeenLedger, toLedger),
              version: { increment: 1 },
            },
          });
          if (advanced.count !== 1) {
            // Another writer moved the cursor: roll back and re-read.
            throw new CursorConflict();
          }
          return newGaps;
        });
        return detected;
      } catch (error) {
        if (error instanceof CursorConflict || isUniqueViolation(error)) {
          continue;
        }
        throw error;
      }
    }
    throw new Error("Contract event cursor is under sustained contention");
  }

  /**
   * Applies an event at most once across live ingestion and backfill.
   *
   * @returns `true` when this call applied the event, `false` when it had
   *   already been applied (the handler is not run).
   */
  async applyEventOnce(
    streamKey: string,
    event: ContractEventRecord,
    handler: ContractEventHandler,
  ): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // The claim and the handler's effects commit or roll back together, so
        // a handler failure leaves the event unclaimed and retryable.
        await tx.contractEventApplied.create({
          data: { streamKey, eventId: event.id, ledger: event.ledger },
        });
        await handler(event, tx);
        return true;
      });
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  /** Gaps for a stream (or all streams), optionally filtered by status. */
  async listGaps(options?: {
    streamKey?: string;
    statuses?: ContractEventGapStatus[];
  }): Promise<GapView[]> {
    const rows = await this.prisma.contractEventGap.findMany({
      where: {
        streamKey: options?.streamKey,
        status: options?.statuses ? { in: options.statuses } : undefined,
      },
      orderBy: [{ streamKey: "asc" }, { fromLedger: "asc" }],
    });
    return rows.map((row) => ({
      id: row.id,
      streamKey: row.streamKey,
      fromLedger: row.fromLedger,
      toLedger: row.toLedger,
      status: row.status,
      attempts: row.attempts,
      failureReason: row.failureReason,
    }));
  }

  /**
   * Backfills open gaps, within the bounds in `options`.
   *
   * Runs off the live path: it only touches gap rows and the applied-events
   * table, never the live cursor. Each chunk is claimed, read, applied, and the
   * gap shrunk, so the work is resumable and a concurrent worker skips a
   * claimed range.
   */
  async runBackfill(
    source: ContractEventSource,
    handler: ContractEventHandler,
    overrides: Partial<BackfillOptions> = {},
  ): Promise<BackfillSummary> {
    const options = { ...DEFAULT_BACKFILL_OPTIONS, ...overrides };
    const summary: BackfillSummary = {
      chunksProcessed: 0,
      eventsApplied: 0,
      eventsSkippedAsDuplicate: 0,
      gapsResolved: 0,
      gapsIrrecoverable: 0,
    };

    for (let chunk = 0; chunk < options.maxChunksPerRun; chunk += 1) {
      const gap = await this.claimNextGap(options.claimLeaseMs);
      if (!gap) break;
      summary.chunksProcessed += 1;
      await this.processChunk(gap, source, handler, options, summary);
    }
    return summary;
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private async recordGap(
    tx: Prisma.TransactionClient,
    streamKey: string,
    fromLedger: number,
    toLedger: number,
  ): Promise<number> {
    const existing = await tx.contractEventGap.findUnique({
      where: {
        streamKey_fromLedger_toLedger: { streamKey, fromLedger, toLedger },
      },
    });
    if (existing) return 0; // idempotent re-observation
    await tx.contractEventGap.create({
      data: { streamKey, fromLedger, toLedger },
    });
    return 1;
  }

  /** Removes `[first, last]` from every open gap it overlaps. */
  private async coverRange(
    tx: Prisma.TransactionClient,
    streamKey: string,
    first: number,
    last: number,
  ): Promise<void> {
    const overlapping = await tx.contractEventGap.findMany({
      where: {
        streamKey,
        status: { in: OPEN },
        fromLedger: { lte: last },
        toLedger: { gte: first },
      },
    });

    for (const gap of overlapping) {
      const left =
        gap.fromLedger < first
          ? { from: gap.fromLedger, to: first - 1 }
          : undefined;
      const right =
        gap.toLedger > last ? { from: last + 1, to: gap.toLedger } : undefined;

      if (!left && !right) {
        await tx.contractEventGap.update({
          where: { id: gap.id },
          data: { status: "RESOLVED", resolvedAt: new Date() },
        });
        continue;
      }

      const [keep, extra] = left ? [left, right] : [right!, undefined];
      await tx.contractEventGap.update({
        where: { id: gap.id },
        data: { fromLedger: keep.from, toLedger: keep.to },
      });
      if (extra) {
        await tx.contractEventGap.create({
          data: {
            streamKey,
            fromLedger: extra.from,
            toLedger: extra.to,
            status: gap.status,
          },
        });
      }
    }
  }

  private async claimNextGap(claimLeaseMs: number) {
    const abandonedBefore = new Date(Date.now() - claimLeaseMs);
    const candidate = await this.prisma.contractEventGap.findFirst({
      where: {
        OR: [
          { status: "DETECTED" },
          { status: "BACKFILLING", updatedAt: { lt: abandonedBefore } },
        ],
      },
      orderBy: [{ streamKey: "asc" }, { fromLedger: "asc" }],
    });
    if (!candidate) return null;

    // Compare-and-set on the exact range and status we read: if another worker
    // claimed it, or live ingestion reshaped it, the count is 0 and we skip.
    const claimed = await this.prisma.contractEventGap.updateMany({
      where: {
        id: candidate.id,
        status: candidate.status,
        fromLedger: candidate.fromLedger,
        toLedger: candidate.toLedger,
      },
      data: { status: "BACKFILLING" },
    });
    return claimed.count === 1 ? candidate : null;
  }

  private async processChunk(
    gap: {
      id: string;
      streamKey: string;
      fromLedger: number;
      toLedger: number;
      attempts: number;
    },
    source: ContractEventSource,
    handler: ContractEventHandler,
    options: BackfillOptions,
    summary: BackfillSummary,
  ): Promise<void> {
    const chunkTo = Math.min(
      gap.toLedger,
      gap.fromLedger + options.maxLedgersPerChunk - 1,
    );

    let page: ContractEventPage;
    try {
      page = await source.fetchEvents(gap.streamKey, gap.fromLedger, chunkTo);
    } catch {
      // Provider output is deliberately not retained: it can carry raw payloads.
      await this.recordFailure(gap, "SOURCE_ERROR", options, summary);
      return;
    }

    if (page.kind === "unavailable") {
      await this.markUnavailable(gap, page.oldestAvailableLedger, summary);
      return;
    }

    const covered = page.coveredThroughLedger;
    if (
      !Number.isSafeInteger(covered) ||
      covered < gap.fromLedger ||
      covered > chunkTo
    ) {
      await this.recordFailure(gap, "INVALID_SOURCE_COVERAGE", options, summary);
      return;
    }

    for (const event of page.events) {
      // Ignore anything outside what was asked for and covered.
      if (event.ledger < gap.fromLedger || event.ledger > covered) continue;
      try {
        const applied = await this.applyEventOnce(gap.streamKey, event, handler);
        if (applied) summary.eventsApplied += 1;
        else summary.eventsSkippedAsDuplicate += 1;
      } catch {
        // The handler failed: the event stays unclaimed and the range is
        // retried from the same point.
        await this.recordFailure(gap, "HANDLER_ERROR", options, summary);
        return;
      }
    }

    await this.recordProgress(gap, covered, summary);
  }

  /** Shrinks the gap to what remains, or resolves it. */
  private async recordProgress(
    gap: { id: string; fromLedger: number; toLedger: number },
    coveredThrough: number,
    summary: BackfillSummary,
  ): Promise<void> {
    const guard = {
      id: gap.id,
      status: "BACKFILLING" as const,
      fromLedger: gap.fromLedger,
      toLedger: gap.toLedger,
    };

    if (coveredThrough >= gap.toLedger) {
      const done = await this.prisma.contractEventGap.updateMany({
        where: guard,
        data: { status: "RESOLVED", resolvedAt: new Date(), failureReason: null },
      });
      if (done.count === 1) summary.gapsResolved += 1;
      return;
    }

    await this.prisma.contractEventGap.updateMany({
      where: guard,
      data: {
        fromLedger: coveredThrough + 1,
        status: "DETECTED",
        attempts: 0,
        failureReason: null,
      },
    });
  }

  private async recordFailure(
    gap: {
      id: string;
      fromLedger: number;
      toLedger: number;
      attempts: number;
    },
    reason: string,
    options: BackfillOptions,
    summary: BackfillSummary,
  ): Promise<void> {
    const attempts = gap.attempts + 1;
    const exhausted = attempts >= options.maxAttempts;
    const result = await this.prisma.contractEventGap.updateMany({
      where: {
        id: gap.id,
        status: "BACKFILLING",
        fromLedger: gap.fromLedger,
        toLedger: gap.toLedger,
      },
      data: {
        attempts,
        failureReason: exhausted ? "RETRIES_EXHAUSTED" : reason,
        status: exhausted ? "IRRECOVERABLE" : "DETECTED",
      },
    });
    if (exhausted && result.count === 1) summary.gapsIrrecoverable += 1;
  }

  /**
   * The provider no longer retains part of the range. The unrecoverable prefix
   * is marked IRRECOVERABLE; any retained remainder stays open for backfill.
   */
  private async markUnavailable(
    gap: { id: string; streamKey: string; fromLedger: number; toLedger: number },
    oldestAvailableLedger: number,
    summary: BackfillSummary,
  ): Promise<void> {
    const lostThrough = Math.min(gap.toLedger, oldestAvailableLedger - 1);
    if (!Number.isSafeInteger(lostThrough) || lostThrough < gap.fromLedger) {
      // Claims to retain the whole range yet reported unavailable: inconsistent.
      await this.recordFailure(
        { ...gap, attempts: 0 },
        "INVALID_SOURCE_COVERAGE",
        { ...DEFAULT_BACKFILL_OPTIONS },
        summary,
      );
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      const lost = await tx.contractEventGap.updateMany({
        where: {
          id: gap.id,
          status: "BACKFILLING",
          fromLedger: gap.fromLedger,
          toLedger: gap.toLedger,
        },
        data: {
          toLedger: lostThrough,
          status: "IRRECOVERABLE",
          failureReason: "PROVIDER_RETENTION",
        },
      });
      if (lost.count !== 1) return;
      summary.gapsIrrecoverable += 1;

      if (lostThrough < gap.toLedger) {
        await tx.contractEventGap.create({
          data: {
            streamKey: gap.streamKey,
            fromLedger: lostThrough + 1,
            toLedger: gap.toLedger,
          },
        });
      }
    });
  }
}

/** Internal signal: the cursor changed under us; the transaction rolls back. */
class CursorConflict extends Error {}

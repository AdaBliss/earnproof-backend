import { Prisma } from "@prisma/client";
import {
  ContractEventGapService,
  type ContractEventPage,
  type ContractEventRecord,
  type ContractEventSource,
} from "./contract-event-gap.service";

/**
 * In-memory stand-in for the three Prisma delegates the service uses. It models
 * the behaviours the service depends on: unique-key violations (P2002),
 * compare-and-set `updateMany`, rollback of an interactive transaction when its
 * callback throws, and serialised transactions. It does not exercise the real
 * database; the SQL in the migration is covered by `prisma validate`/generate.
 */

type Row = Record<string, any>;
type Where = Record<string, any>;

function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (condition === undefined) return true; // Prisma ignores undefined filters
    if (key === "OR") return (condition as Where[]).some((w) => matches(row, w));
    const value = row[key];
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      if ("in" in condition) return condition.in.includes(value);
      if ("lte" in condition && !(value <= condition.lte)) return false;
      if ("gte" in condition && !(value >= condition.gte)) return false;
      if ("lt" in condition && !(value < condition.lt)) return false;
      return true;
    }
    return value === condition;
  });
}

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError("duplicate", {
    code: "P2002",
    clientVersion: "test",
  });
}

function applyData(row: Row, data: Row) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && "increment" in value) {
      row[key] += value.increment;
    } else {
      row[key] = value;
    }
  }
  row.updatedAt = new Date();
}

function createFakePrisma() {
  const store = {
    cursors: [] as Row[],
    gaps: [] as Row[],
    applied: [] as Row[],
  };
  let nextId = 1;
  const hooks: { beforeCursorUpdate?: () => void } = {};

  const gapDelegate = {
    findUnique: async ({ where }: Row) => {
      const k = where.streamKey_fromLedger_toLedger;
      const found = store.gaps.find(
        (g) =>
          g.streamKey === k.streamKey &&
          g.fromLedger === k.fromLedger &&
          g.toLedger === k.toLedger,
      );
      return found ? { ...found } : null;
    },
    create: async ({ data }: Row) => {
      if (
        store.gaps.some(
          (g) =>
            g.streamKey === data.streamKey &&
            g.fromLedger === data.fromLedger &&
            g.toLedger === data.toLedger,
        )
      ) {
        throw uniqueViolation();
      }
      const row = {
        id: `gap-${nextId++}`,
        status: "DETECTED",
        attempts: 0,
        failureReason: null,
        resolvedAt: null,
        detectedAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      store.gaps.push(row);
      return { ...row };
    },
    findMany: async ({ where }: Row = {}) =>
      store.gaps
        .filter((g) => matches(g, where))
        .sort((a, b) => a.streamKey.localeCompare(b.streamKey) || a.fromLedger - b.fromLedger)
        .map((g) => ({ ...g })),
    findFirst: async ({ where }: Row) => {
      const found = store.gaps
        .filter((g) => matches(g, where))
        .sort((a, b) => a.streamKey.localeCompare(b.streamKey) || a.fromLedger - b.fromLedger)[0];
      return found ? { ...found } : null;
    },
    update: async ({ where, data }: Row) => {
      const row = store.gaps.find((g) => g.id === where.id)!;
      applyData(row, data);
      return { ...row };
    },
    updateMany: async ({ where, data }: Row) => {
      const rows = store.gaps.filter((g) => matches(g, where));
      rows.forEach((row) => applyData(row, data));
      return { count: rows.length };
    },
  };

  const prisma = {
    contractEventCursor: {
      findUnique: async ({ where }: Row) => {
        const found = store.cursors.find((c) => c.streamKey === where.streamKey);
        return found ? { ...found } : null;
      },
      create: async ({ data }: Row) => {
        if (store.cursors.some((c) => c.streamKey === data.streamKey)) {
          throw uniqueViolation();
        }
        const row = { version: 0, ...data };
        store.cursors.push(row);
        return row;
      },
      updateMany: async ({ where, data }: Row) => {
        hooks.beforeCursorUpdate?.();
        const rows = store.cursors.filter((c) => matches(c, where));
        rows.forEach((row) => applyData(row, data));
        return { count: rows.length };
      },
    },
    contractEventGap: gapDelegate,
    contractEventApplied: {
      create: async ({ data }: Row) => {
        if (
          store.applied.some(
            (a) => a.streamKey === data.streamKey && a.eventId === data.eventId,
          )
        ) {
          throw uniqueViolation();
        }
        store.applied.push({ ...data });
      },
    },
    // Serialised, snapshot/rollback transaction.
    $transaction: undefined as unknown as (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown>,
  };

  let tail: Promise<unknown> = Promise.resolve();
  prisma.$transaction = (cb) => {
    const run = tail.then(async () => {
      const snapshot = JSON.stringify(store);
      try {
        return await cb(prisma);
      } catch (error) {
        const restored = JSON.parse(snapshot);
        for (const key of Object.keys(store) as (keyof typeof store)[]) {
          store[key].length = 0;
          store[key].push(...restored[key].map(reviveDates));
        }
        throw error;
      }
    });
    tail = run.catch(() => undefined);
    return run;
  };

  return { prisma, store, hooks };
}

function reviveDates(row: Row): Row {
  for (const key of ["updatedAt", "detectedAt", "resolvedAt"]) {
    if (typeof row[key] === "string") row[key] = new Date(row[key]);
  }
  return row;
}

const STREAM = "testnet:CCONTRACT";

function setup() {
  const fake = createFakePrisma();
  const service = new ContractEventGapService(fake.prisma as never);
  const gaps = () =>
    fake.store.gaps.map((g) => ({
      from: g.fromLedger,
      to: g.toLedger,
      status: g.status,
    }));
  return { ...fake, service, gaps };
}

function sourceReturning(
  respond: (from: number, to: number) => ContractEventPage | Promise<ContractEventPage>,
) {
  return { fetchEvents: jest.fn(async (_s: string, from: number, to: number) => respond(from, to)) };
}

/** A source that holds every ledger and one event per ledger. */
function fullSource(): ContractEventSource & { fetchEvents: jest.Mock } {
  return sourceReturning((from, to) => ({
    kind: "events",
    events: Array.from({ length: to - from + 1 }, (_, i) => ({
      id: `evt-${from + i}`,
      ledger: from + i,
    })),
    coveredThroughLedger: to,
  }));
}

const noopHandler = async () => undefined;

describe("ContractEventGapService.observeLiveRange", () => {
  it("establishes a baseline on first sight without recording a gap", async () => {
    const { service, gaps } = setup();

    await expect(service.observeLiveRange(STREAM, 100, 110)).resolves.toBe(0);
    expect(gaps()).toEqual([]);
  });

  it("extends the cursor for a contiguous range", async () => {
    const { service, gaps, store } = setup();
    await service.observeLiveRange(STREAM, 100, 110);

    await expect(service.observeLiveRange(STREAM, 111, 120)).resolves.toBe(0);

    expect(gaps()).toEqual([]);
    expect(store.cursors[0].highestSeenLedger).toBe(120);
  });

  it("records a skipped range as a durable gap with status and range", async () => {
    const { service, gaps } = setup();
    await service.observeLiveRange(STREAM, 100, 110);

    await expect(service.observeLiveRange(STREAM, 150, 160)).resolves.toBe(1);

    expect(gaps()).toEqual([{ from: 111, to: 149, status: "DETECTED" }]);
  });

  it("keeps separate streams independent", async () => {
    const { service, gaps } = setup();
    await service.observeLiveRange("a", 1, 5);
    await service.observeLiveRange("b", 1, 5);
    await service.observeLiveRange("a", 20, 25);

    expect(gaps()).toEqual([{ from: 6, to: 19, status: "DETECTED" }]);
    await expect(service.listGaps({ streamKey: "b" })).resolves.toEqual([]);
  });

  it("accepts re-delivery of an already-seen range without side effects", async () => {
    const { service, gaps, store } = setup();
    await service.observeLiveRange(STREAM, 100, 110);
    await service.observeLiveRange(STREAM, 150, 160);

    await service.observeLiveRange(STREAM, 100, 110); // overlap, below the gap
    await service.observeLiveRange(STREAM, 150, 160); // exact repeat

    expect(gaps()).toEqual([{ from: 111, to: 149, status: "DETECTED" }]);
    expect(store.cursors[0].highestSeenLedger).toBe(160);
  });

  it("splits a gap when a late live range lands in its middle", async () => {
    const { service, gaps } = setup();
    await service.observeLiveRange(STREAM, 100, 110);
    await service.observeLiveRange(STREAM, 150, 160);

    await service.observeLiveRange(STREAM, 120, 130);

    expect(gaps()).toEqual([
      { from: 111, to: 119, status: "DETECTED" },
      { from: 131, to: 149, status: "DETECTED" },
    ]);
  });

  it("trims a gap from either edge", async () => {
    const { service, gaps } = setup();
    await service.observeLiveRange(STREAM, 100, 110);
    await service.observeLiveRange(STREAM, 150, 160);

    await service.observeLiveRange(STREAM, 105, 120); // overlaps seen + start of gap
    await service.observeLiveRange(STREAM, 140, 155); // end of gap + seen

    expect(gaps()).toEqual([{ from: 121, to: 139, status: "DETECTED" }]);
  });

  it("resolves a gap that a live range covers entirely", async () => {
    const { service, gaps } = setup();
    await service.observeLiveRange(STREAM, 100, 110);
    await service.observeLiveRange(STREAM, 150, 160);

    await service.observeLiveRange(STREAM, 111, 149);

    expect(gaps()).toEqual([{ from: 111, to: 149, status: "RESOLVED" }]);
  });

  it("retries when another writer advances the cursor concurrently", async () => {
    const { service, hooks, store } = setup();
    await service.observeLiveRange(STREAM, 100, 110);
    let interfered = false;
    hooks.beforeCursorUpdate = () => {
      if (!interfered) {
        interfered = true;
        store.cursors[0].version += 1; // a concurrent writer committed first
      }
    };

    await expect(service.observeLiveRange(STREAM, 111, 120)).resolves.toBe(0);

    expect(store.cursors[0].highestSeenLedger).toBe(120);
  });

  it("does not record a gap twice when the same jump is observed concurrently", async () => {
    const { service, gaps } = setup();
    await service.observeLiveRange(STREAM, 100, 110);

    await Promise.all([
      service.observeLiveRange(STREAM, 150, 160),
      service.observeLiveRange(STREAM, 150, 160),
    ]);

    expect(gaps()).toEqual([{ from: 111, to: 149, status: "DETECTED" }]);
  });

  it.each([
    [10, 5],
    [-1, 5],
    [1.5, 5],
    [Number.NaN, 5],
  ])("rejects an invalid range (%p, %p)", async (from, to) => {
    const { service } = setup();
    await expect(service.observeLiveRange(STREAM, from, to)).rejects.toThrow(RangeError);
  });
});

describe("ContractEventGapService.applyEventOnce", () => {
  const event: ContractEventRecord = { id: "evt-1", ledger: 10 };

  it("applies an event once and skips it afterwards", async () => {
    const { service } = setup();
    const handler = jest.fn(noopHandler);

    expect(await service.applyEventOnce(STREAM, event, handler)).toBe(true);
    expect(await service.applyEventOnce(STREAM, event, handler)).toBe(false);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("leaves the event unclaimed when the handler fails, so it can be retried", async () => {
    const { service, store } = setup();

    await expect(
      service.applyEventOnce(STREAM, event, async () => {
        throw new Error("projection failed");
      }),
    ).rejects.toThrow("projection failed");
    expect(store.applied).toHaveLength(0);

    const handler = jest.fn(noopHandler);
    expect(await service.applyEventOnce(STREAM, event, handler)).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("applies the same event id in different streams independently", async () => {
    const { service } = setup();
    expect(await service.applyEventOnce("a", event, noopHandler)).toBe(true);
    expect(await service.applyEventOnce("b", event, noopHandler)).toBe(true);
  });

  it("admits an event exactly once under concurrent live and backfill delivery", async () => {
    const { service } = setup();
    const handler = jest.fn(noopHandler);

    const results = await Promise.all([
      service.applyEventOnce(STREAM, event, handler),
      service.applyEventOnce(STREAM, event, handler),
      service.applyEventOnce(STREAM, event, handler),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("ContractEventGapService.runBackfill", () => {
  async function withGap(from: number, to: number) {
    const ctx = setup();
    await ctx.service.observeLiveRange(STREAM, from - 1, from - 1);
    await ctx.service.observeLiveRange(STREAM, to + 1, to + 5);
    expect(ctx.gaps()).toEqual([{ from, to, status: "DETECTED" }]);
    return ctx;
  }

  it("backfills a gap and resolves it", async () => {
    const { service, gaps } = await withGap(100, 149);
    const handler = jest.fn(noopHandler);

    const summary = await service.runBackfill(fullSource(), handler);

    expect(summary).toMatchObject({ chunksProcessed: 1, eventsApplied: 50, gapsResolved: 1 });
    expect(handler).toHaveBeenCalledTimes(50);
    expect(gaps()).toEqual([{ from: 100, to: 149, status: "RESOLVED" }]);
  });

  it("is bounded: processes at most maxChunksPerRun chunks of maxLedgersPerChunk", async () => {
    const { service, gaps } = await withGap(1, 2000);
    const source = fullSource();

    const summary = await service.runBackfill(source, noopHandler, {
      maxLedgersPerChunk: 500,
      maxChunksPerRun: 2,
    });

    expect(summary.chunksProcessed).toBe(2);
    expect(source.fetchEvents).toHaveBeenCalledTimes(2);
    expect(source.fetchEvents).toHaveBeenNthCalledWith(1, STREAM, 1, 500);
    expect(source.fetchEvents).toHaveBeenNthCalledWith(2, STREAM, 501, 1000);
    expect(gaps()).toEqual([{ from: 1001, to: 2000, status: "DETECTED" }]);
  });

  it("is resumable: a later run continues from where the last stopped", async () => {
    const { service, gaps } = await withGap(1, 1200);
    const options = { maxLedgersPerChunk: 500, maxChunksPerRun: 1 };

    await service.runBackfill(fullSource(), noopHandler, options);
    await service.runBackfill(fullSource(), noopHandler, options);
    expect(gaps()).toEqual([{ from: 1001, to: 1200, status: "DETECTED" }]);

    await service.runBackfill(fullSource(), noopHandler, options);
    expect(gaps()).toEqual([{ from: 1001, to: 1200, status: "RESOLVED" }]);
  });

  it("advances only to the ledger the source says it covered", async () => {
    const { service, gaps } = await withGap(100, 199);
    const truncated = sourceReturning((from) => ({
      kind: "events",
      events: [{ id: "e-100", ledger: 100 }],
      coveredThroughLedger: from + 9,
    }));

    await service.runBackfill(truncated, noopHandler, { maxChunksPerRun: 1 });

    expect(gaps()).toEqual([{ from: 110, to: 199, status: "DETECTED" }]);
  });

  it("is idempotent: re-running a resolved range applies nothing", async () => {
    const { service } = await withGap(100, 109);
    const handler = jest.fn(noopHandler);
    await service.runBackfill(fullSource(), handler);

    const summary = await service.runBackfill(fullSource(), handler);

    expect(summary.chunksProcessed).toBe(0);
    expect(handler).toHaveBeenCalledTimes(10);
  });

  it("does not double-apply events live ingestion already applied", async () => {
    const { service } = await withGap(100, 109);
    const handler = jest.fn(noopHandler);
    await service.applyEventOnce(STREAM, { id: "evt-105", ledger: 105 }, handler);

    const summary = await service.runBackfill(fullSource(), handler);

    expect(summary.eventsApplied).toBe(9);
    expect(summary.eventsSkippedAsDuplicate).toBe(1);
    expect(handler).toHaveBeenCalledTimes(10);
  });

  it("ignores events outside the requested and covered range", async () => {
    const { service } = await withGap(100, 109);
    const handler = jest.fn(noopHandler);
    const noisy = sourceReturning(() => ({
      kind: "events",
      events: [
        { id: "before", ledger: 99 },
        { id: "inside", ledger: 105 },
        { id: "after", ledger: 110 },
      ],
      coveredThroughLedger: 109,
    }));

    await service.runBackfill(noisy, handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ id: "inside", ledger: 105 }, expect.anything());
  });

  it("two workers do not process the same gap", async () => {
    const { service } = await withGap(100, 109);
    const source = fullSource();

    await Promise.all([
      service.runBackfill(source, noopHandler),
      service.runBackfill(source, noopHandler),
    ]);

    expect(source.fetchEvents).toHaveBeenCalledTimes(1);
  });

  it("reclaims a claim abandoned past the lease, but not a fresh one", async () => {
    const { service, store } = await withGap(100, 109);
    store.gaps[0].status = "BACKFILLING";
    store.gaps[0].updatedAt = new Date();

    const fresh = await service.runBackfill(fullSource(), noopHandler);
    expect(fresh.chunksProcessed).toBe(0);

    store.gaps[0].updatedAt = new Date(Date.now() - 60 * 60_000);
    const abandoned = await service.runBackfill(fullSource(), noopHandler);
    expect(abandoned.gapsResolved).toBe(1);
  });

  it("does not clobber a gap live ingestion resolved while the backfill was reading", async () => {
    const { service, gaps } = await withGap(100, 109);
    const source = sourceReturning(async (from, to) => {
      await service.observeLiveRange(STREAM, 100, 109); // live delivers it meanwhile
      return {
        kind: "events",
        events: [],
        coveredThroughLedger: to,
      };
    });

    const summary = await service.runBackfill(source, noopHandler);

    expect(gaps()).toEqual([{ from: 100, to: 109, status: "RESOLVED" }]);
    expect(summary.gapsResolved).toBe(0); // live resolved it, not this run
  });

  describe("irrecoverable ranges", () => {
    it("marks the whole range irrecoverable when the provider retains none of it", async () => {
      const { service, gaps, store } = await withGap(100, 199);
      const truncated = sourceReturning(() => ({ kind: "unavailable", oldestAvailableLedger: 500 }));

      const summary = await service.runBackfill(truncated, noopHandler);

      expect(gaps()).toEqual([{ from: 100, to: 199, status: "IRRECOVERABLE" }]);
      expect(store.gaps[0].failureReason).toBe("PROVIDER_RETENTION");
      expect(summary.gapsIrrecoverable).toBe(1);
    });

    it("splits the range: lost prefix is irrecoverable, retained remainder is backfilled", async () => {
      const { service, gaps } = await withGap(100, 199);
      const source = sourceReturning((from, to) =>
        from < 150
          ? { kind: "unavailable", oldestAvailableLedger: 150 }
          : {
              kind: "events",
              events: [{ id: `e-${from}`, ledger: from }],
              coveredThroughLedger: to,
            },
      );

      await service.runBackfill(source, noopHandler);

      expect(gaps()).toEqual([
        { from: 100, to: 149, status: "IRRECOVERABLE" },
        { from: 150, to: 199, status: "RESOLVED" },
      ]);
    });

    it("never retries an irrecoverable range", async () => {
      const { service } = await withGap(100, 199);
      await service.runBackfill(
        sourceReturning(() => ({ kind: "unavailable", oldestAvailableLedger: 500 })),
        noopHandler,
      );
      const source = fullSource();

      await service.runBackfill(source, noopHandler);

      expect(source.fetchEvents).not.toHaveBeenCalled();
    });

    it("keeps the range open for retry on a transient source error, then gives up", async () => {
      const { service, gaps, store } = await withGap(100, 109);
      const failing = sourceReturning(() => {
        throw new Error("rpc payload: SECRET-RAW-RESPONSE");
      });

      await service.runBackfill(failing, noopHandler, { maxAttempts: 3, maxChunksPerRun: 1 });
      expect(gaps()).toEqual([{ from: 100, to: 109, status: "DETECTED" }]);
      expect(store.gaps[0].attempts).toBe(1);

      await service.runBackfill(failing, noopHandler, { maxAttempts: 3, maxChunksPerRun: 1 });
      const last = await service.runBackfill(failing, noopHandler, { maxAttempts: 3, maxChunksPerRun: 1 });

      expect(gaps()).toEqual([{ from: 100, to: 109, status: "IRRECOVERABLE" }]);
      expect(store.gaps[0].failureReason).toBe("RETRIES_EXHAUSTED");
      expect(last.gapsIrrecoverable).toBe(1);
      expect(JSON.stringify(store.gaps)).not.toContain("SECRET-RAW-RESPONSE");
    });

    it("treats a source claiming impossible coverage as a failure, not progress", async () => {
      const { service, gaps, store } = await withGap(100, 109);
      const lying = sourceReturning(() => ({ kind: "events", events: [], coveredThroughLedger: 5_000 }));

      await service.runBackfill(lying, noopHandler, { maxChunksPerRun: 1 });

      expect(gaps()).toEqual([{ from: 100, to: 109, status: "DETECTED" }]);
      expect(store.gaps[0].failureReason).toBe("INVALID_SOURCE_COVERAGE");
    });

    it("retries from the same point when the handler fails, applying nothing partially", async () => {
      const { service, gaps, store } = await withGap(100, 109);
      const handler = jest.fn(async (event: ContractEventRecord) => {
        if (event.ledger === 105) throw new Error("projection failed");
      });

      await service.runBackfill(fullSource(), handler, { maxChunksPerRun: 1 });

      expect(gaps()).toEqual([{ from: 100, to: 109, status: "DETECTED" }]);
      expect(store.gaps[0].failureReason).toBe("HANDLER_ERROR");
      expect(store.applied.map((a) => a.ledger).sort()).toEqual([100, 101, 102, 103, 104]);
    });
  });
});

describe("ContractEventGapService.listGaps", () => {
  it("exposes range, status, and attempts, filtered by status", async () => {
    const { service } = setup();
    await service.observeLiveRange(STREAM, 1, 10);
    await service.observeLiveRange(STREAM, 20, 30);
    await service.observeLiveRange(STREAM, 11, 19); // resolves the gap

    await expect(service.listGaps({ statuses: ["DETECTED"] })).resolves.toEqual([]);
    await expect(service.listGaps({ streamKey: STREAM })).resolves.toEqual([
      expect.objectContaining({
        fromLedger: 11,
        toLedger: 19,
        status: "RESOLVED",
        attempts: 0,
        failureReason: null,
      }),
    ]);
  });
});

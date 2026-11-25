import { ForbiddenException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { registerCoreMetrics } from "../common/observability/metrics.catalog";
import { MetricsRegistry } from "../common/observability/metrics.registry";
import {
  TransactionRetryExhaustedError,
  TransactionRetryService,
  type TransactionRetryOptions,
} from "./transaction-retry.service";

/** A Prisma deadlock error, as the engine surfaces it. */
function deadlockError() {
  return new Prisma.PrismaClientKnownRequestError(
    "Transaction failed due to a write conflict or a deadlock. Please retry your transaction",
    { code: "P2034", clientVersion: "6.0.0" },
  );
}

function uniqueViolationError() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "6.0.0",
  });
}

/**
 * Scripted stand-in for `PrismaService.$transaction`: each call runs the
 * callback against a fake transaction client, then either resolves with the
 * callback's value (a commit) or throws the scripted error (a rollback).
 * `committed` records only the values of calls that resolved, which is
 * what makes "the retry did not duplicate committed work" observable.
 */
interface FakePrisma {
  $transaction: jest.Mock;
  committed: unknown[];
}

function makeFakePrisma(
  script: Array<{ error: unknown } | { value: unknown }>,
): FakePrisma {
  const committed: unknown[] = [];
  const $transaction = jest.fn(
    async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {};
      const step = script.shift();
      if (!step) throw new Error("script exhausted: unexpected $transaction call");
      const value = await fn(tx);
      if ("error" in step) throw step.error;
      committed.push(value);
      return value;
    },
  );
  return { $transaction, committed };
}

function makeService(fake: FakePrisma, registry = new MetricsRegistry()) {
  registerCoreMetrics(registry);
  const service = new TransactionRetryService(
    fake as unknown as never,
    registry,
  );
  return { service, registry };
}

const BASE: TransactionRetryOptions = {
  operation: "test-operation",
  random: () => 0.5,
  sleep: () => Promise.resolve(),
};

function counterValue(
  registry: MetricsRegistry,
  labels: Record<string, string>,
): number {
  const snapshot = registry
    .snapshot()
    .find((entry) => entry.name === "database_transaction_retries_total");
  if (!snapshot || snapshot.type !== "counter") return 0;
  return (
    snapshot.series.find((series) => {
      const labelsByName = series.labels as Record<string, string | undefined>;
      return Object.entries(labels).every(
        ([key, value]) => labelsByName[key] === value,
      );
    })?.value ?? 0
  );
}

describe("TransactionRetryService", () => {
  // Silence the operational logger: retry warnings are expected here.
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Positive ───────────────────────────────────────────────────────────

  describe("successful retries", () => {
    it("returns the first-attempt result without retrying", async () => {
      const fake = makeFakePrisma([{ value: "ok" }]);
      const { service } = makeService(fake);

      const result = await service.runInTransaction(async () => "ok", BASE);

      expect(result).toBe("ok");
      expect(fake.$transaction).toHaveBeenCalledTimes(1);
      expect(service.recentDiagnostics()).toEqual([]);
    });

    it("retries a deadlock and returns the retried result", async () => {
      const fake = makeFakePrisma([
        { error: deadlockError() },
        { value: "committed" },
      ]);
      const { service } = makeService(fake);

      const result = await service.runInTransaction(async () => "committed", BASE);

      expect(result).toBe("committed");
      expect(fake.$transaction).toHaveBeenCalledTimes(2);
      expect(fake.committed).toEqual(["committed"]);
    });

    it("does not duplicate committed work: a rolled-back attempt commits nothing", async () => {
      const fake = makeFakePrisma([
        { error: deadlockError() },
        { error: deadlockError() },
        { value: "row-1" },
      ]);
      const { service } = makeService(fake);
      const attempts: string[] = [];

      const result = await service.runInTransaction(async () => {
        attempts.push("attempt");
        return "row-1";
      }, BASE);

      expect(result).toBe("row-1");
      expect(attempts).toHaveLength(3);
      // Only the attempt that resolved committed; the two rolled-back
      // attempts left nothing behind.
      expect(fake.committed).toEqual(["row-1"]);
    });

    it("records a succeeded_after_retry diagnostic with redacted detail", async () => {
      const fake = makeFakePrisma([
        { error: deadlockError() },
        { value: "done" },
      ]);
      const { service } = makeService(fake);

      await service.runInTransaction(async () => "done", BASE);

      const [diagnostic] = service.recentDiagnostics();
      expect(diagnostic).toMatchObject({
        operation: "test-operation",
        outcome: "succeeded_after_retry",
        attempts: 2,
      });
      expect(diagnostic.attemptDiagnostics).toHaveLength(1);
      expect(diagnostic.attemptDiagnostics[0]).toMatchObject({
        attempt: 1,
        category: "deadlock",
      });
      expect(diagnostic.attemptDiagnostics[0].redactedError).toContain("deadlock");
      expect(diagnostic.attemptDiagnostics[0].delayMs).toBeDefined();
    });

    it("counts retried attempts on the retry metric by category", async () => {
      const fake = makeFakePrisma([
        { error: deadlockError() },
        { value: "done" },
      ]);
      const { service, registry } = makeService(fake);

      await service.runInTransaction(async () => "done", BASE);

      expect(
        counterValue(registry, {
          db_error_category: "deadlock",
          retry_outcome: "retried",
        }),
      ).toBe(1);
    });
  });

  // ── Negative ───────────────────────────────────────────────────────────

  describe("failures that must not retry", () => {
    it("does not retry a unique-constraint violation and rethrows it unchanged", async () => {
      const fake = makeFakePrisma([{ error: uniqueViolationError() }]);
      const { service } = makeService(fake);
      const thrown = uniqueViolationError();

      await expect(
        service.runInTransaction(async () => {
          throw thrown;
        }, BASE),
      ).rejects.toBe(thrown);
      expect(fake.$transaction).toHaveBeenCalledTimes(1);
    });

    it("does not retry when allowRetry is false, even for a deadlock", async () => {
      const fake = makeFakePrisma([{ error: deadlockError() }]);
      const { service } = makeService(fake);
      const thrown = deadlockError();

      await expect(
        service.runInTransaction(
          async () => {
            throw thrown;
          },
          { ...BASE, allowRetry: false },
        ),
      ).rejects.toBe(thrown);
      expect(fake.$transaction).toHaveBeenCalledTimes(1);
    });

    it("throws a stable exhausted error after the retry budget is spent", async () => {
      const fake = makeFakePrisma([
        { error: deadlockError() },
        { error: deadlockError() },
        { error: deadlockError() },
      ]);
      const { service, registry } = makeService(fake);

      const error = await service
        .runInTransaction(async () => "never", BASE)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(TransactionRetryExhaustedError);
      const exhausted = error as TransactionRetryExhaustedError;
      expect(exhausted.status).toBe("retry_exhausted");
      expect(exhausted.operation).toBe("test-operation");
      expect(exhausted.attempts).toBe(3);
      expect(exhausted.lastCategory).toBe("deadlock");
      expect(exhausted.lastPrismaCode).toBe("P2034");
      expect(exhausted.cause).toBeInstanceOf(Error);
      expect(fake.$transaction).toHaveBeenCalledTimes(3);
      expect(fake.committed).toEqual([]);
      expect(
        counterValue(registry, {
          db_error_category: "deadlock",
          retry_outcome: "exhausted",
        }),
      ).toBe(1);
    });

    it("records an exhausted diagnostic with every attempt", async () => {
      const fake = makeFakePrisma([
        { error: deadlockError() },
        { error: deadlockError() },
        { error: deadlockError() },
      ]);
      const { service } = makeService(fake);

      await expect(
        service.runInTransaction(async () => "never", BASE),
      ).rejects.toBeInstanceOf(TransactionRetryExhaustedError);

      const [diagnostic] = service.recentDiagnostics();
      expect(diagnostic).toMatchObject({
        outcome: "retry_exhausted",
        attempts: 3,
      });
      expect(diagnostic.attemptDiagnostics).toHaveLength(3);
      expect(diagnostic.attemptDiagnostics[2].delayMs).toBeUndefined();
    });

    it("does not count a non-retryable failure on the retry metric", async () => {
      const fake = makeFakePrisma([{ error: uniqueViolationError() }]);
      const { service, registry } = makeService(fake);

      await expect(
        service.runInTransaction(async () => {
          throw uniqueViolationError();
        }, BASE),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);

      expect(
        counterValue(registry, {
          db_error_category: "conflict",
          retry_outcome: "exhausted",
        }),
      ).toBe(0);
    });
  });

  // ── Authorization ──────────────────────────────────────────────────────

  describe("authorization", () => {
    it("never retries an authorization failure and propagates it unchanged", async () => {
      const fake = makeFakePrisma([{ value: "unused" }]);
      const { service } = makeService(fake);
      const forbidden = new ForbiddenException("not allowed");

      await expect(
        service.runInTransaction(async () => {
          throw forbidden;
        }, BASE),
      ).rejects.toBe(forbidden);
      expect(fake.$transaction).toHaveBeenCalledTimes(1);
      expect(service.recentDiagnostics()[0]).toMatchObject({
        outcome: "failed_non_retryable",
      });
    });

    it("runs the callback inside the transaction the caller opened, not a new one", async () => {
      const fake = makeFakePrisma([{ value: "ok" }]);
      const { service } = makeService(fake);
      const seen: unknown[] = [];

      await service.runInTransaction(async (tx) => {
        seen.push(tx);
        return "ok";
      }, BASE);

      // The callback received the interactive-transaction client from the
      // single $transaction call — no second transaction was opened, so no
      // authorization context established by the caller is ever re-entered
      // under a different transaction.
      expect(fake.$transaction).toHaveBeenCalledTimes(1);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual({});
    });
  });

  // ── Boundary ───────────────────────────────────────────────────────────

  describe("boundaries", () => {
    it("maxAttempts: 1 never retries", async () => {
      const fake = makeFakePrisma([{ error: deadlockError() }]);
      const { service } = makeService(fake);

      await expect(
        service.runInTransaction(async () => "never", {
          ...BASE,
          maxAttempts: 1,
        }),
      ).rejects.toBeInstanceOf(TransactionRetryExhaustedError);
      expect(fake.$transaction).toHaveBeenCalledTimes(1);
    });

    it("clamps maxAttempts above 10 to 10 attempts", async () => {
      const script = Array.from({ length: 10 }, () => ({
        error: deadlockError(),
      }));
      const fake = makeFakePrisma(script);
      const { service } = makeService(fake);

      await expect(
        service.runInTransaction(async () => "never", {
          ...BASE,
          maxAttempts: 99,
        }),
      ).rejects.toBeInstanceOf(TransactionRetryExhaustedError);
      expect(fake.$transaction).toHaveBeenCalledTimes(10);
    });

    it("clamps maxAttempts below 1 to a single attempt", async () => {
      const fake = makeFakePrisma([{ error: deadlockError() }]);
      const { service } = makeService(fake);

      await expect(
        service.runInTransaction(async () => "never", {
          ...BASE,
          maxAttempts: 0,
        }),
      ).rejects.toBeInstanceOf(TransactionRetryExhaustedError);
      expect(fake.$transaction).toHaveBeenCalledTimes(1);
    });

    it("bounds the delay by maxDelayMs with a fixed jitter source", async () => {
      const fake = makeFakePrisma([
        { error: deadlockError() },
        { error: deadlockError() },
        { value: "done" },
      ]);
      const { service } = makeService(fake);
      const delays: number[] = [];

      await service.runInTransaction(async () => "done", {
        ...BASE,
        baseDelayMs: 100,
        maxDelayMs: 150,
        random: () => 1,
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      });

      // Full jitter with random() = 1: delay is the cap itself. Attempt 1
      // caps at min(100, 150) = 100; attempt 2 caps at min(200, 150) = 150.
      expect(delays).toEqual([100, 150]);
    });

    it("rejects an operation name that could carry unbounded content", async () => {
      const fake = makeFakePrisma([{ value: "ok" }]);
      const { service } = makeService(fake);

      await expect(
        service.runInTransaction(async () => "ok", {
          ...BASE,
          operation: "Proof 123; DROP TABLE users",
        }),
      ).rejects.toThrow(/Invalid transaction operation name/);
      expect(fake.$transaction).not.toHaveBeenCalled();
    });

    it("keeps only the most recent 100 diagnostics", async () => {
      const alwaysDeadlocks = {
        $transaction: jest.fn(async () => {
          throw deadlockError();
        }),
        committed: [] as unknown[],
      };
      const { service } = makeService(alwaysDeadlocks);

      for (let index = 0; index < 105; index++) {
        await expect(
          service.runInTransaction(async () => "never", {
            ...BASE,
            maxAttempts: 1,
          }),
        ).rejects.toBeInstanceOf(TransactionRetryExhaustedError);
      }

      const diagnostics = service.recentDiagnostics();
      expect(diagnostics).toHaveLength(100);
      expect(diagnostics[0].attempts).toBe(1);
      expect(diagnostics[99].attempts).toBe(1);
    });

    it("redacts sensitive values from recorded diagnostics", async () => {
      const fake = makeFakePrisma([
        {
          error: Object.assign(
            new Error(
              "deadlock for wallet GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            ),
            { code: "40P01" },
          ),
        },
        { value: "done" },
      ]);
      const { service } = makeService(fake);

      await service.runInTransaction(async () => "done", BASE);

      const [diagnostic] = service.recentDiagnostics();
      expect(diagnostic.attemptDiagnostics[0].redactedError).not.toContain(
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      );
      expect(diagnostic.attemptDiagnostics[0].redactedError).toContain(
        "[REDACTED_ADDRESS]",
      );
    });
  });

  // ── Regression ─────────────────────────────────────────────────────────

  describe("regression", () => {
    it("passes transaction options through to Prisma unchanged", async () => {
      const fake = makeFakePrisma([{ value: "ok" }]);
      const { service } = makeService(fake);

      await service.runInTransaction(async () => "ok", {
        ...BASE,
        isolationLevel: "Serializable",
        maxWait: 500,
        timeout: 2000,
      });

      expect(fake.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: "Serializable",
        maxWait: 500,
        timeout: 2000,
      });
    });

    it("works without a metrics registry (observability module absent)", async () => {
      const fake = makeFakePrisma([
        { error: deadlockError() },
        { value: "done" },
      ]);
      const service = new TransactionRetryService(
        fake as unknown as never,
        undefined,
      );

      await expect(
        service.runInTransaction(async () => "done", BASE),
      ).resolves.toBe("done");
    });

    it("does not record a metric when the registry never registered the counter", async () => {
      const fake = makeFakePrisma([
        { error: deadlockError() },
        { value: "done" },
      ]);
      // A bare registry: the counter was never registered, so increment
      // would throw — the service must absorb that rather than fail the
      // transaction it is protecting.
      const service = new TransactionRetryService(
        fake as unknown as never,
        new MetricsRegistry(),
      );

      await expect(
        service.runInTransaction(async () => "done", BASE),
      ).resolves.toBe("done");
    });
  });
});

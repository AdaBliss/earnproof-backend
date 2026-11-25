import { TransactionRetryExhaustedError } from "../../src/database/transaction-retry.service";
import { TransactionRetryService } from "../../src/database/transaction-retry.service";
import { integrationDatabase } from "./harness/database";
import { integrationModule } from "./harness/nest";

/**
 * Deadlock retry against a real PostgreSQL database.
 *
 * A mock can prove the retry loop re-invokes its callback, but it cannot
 * prove the thing that matters: that a real PostgreSQL deadlock aborts one
 * transaction, that the aborted work is fully rolled back, and that the
 * retry then commits exactly once. Only the database can decide a deadlock,
 * so this file forces one.
 *
 * The deadlock is forced with advisory locks, taken in opposite order by
 * two concurrent transactions: A holds 101 and waits for 102 while B holds
 * 102 and waits for 101. PostgreSQL detects the cycle (within its
 * `deadlock_timeout`) and aborts one transaction with SQLSTATE 40P01,
 * which Prisma surfaces as P2010. The aborted transaction must then retry
 * and commit exactly one row — the row its first attempt inserted was
 * rolled back with the abort, so a second committed copy would prove the
 * retry duplicated non-idempotent work.
 *
 * Requires a live test database (`TEST_DATABASE_URL`); see
 * docs/integration-testing.md. It is deliberately not part of the unit
 * suite, which must stay runnable with no database at all.
 */

const db = integrationDatabase();
const injector = integrationModule([]);

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("transaction deadlock retry", () => {
  it("retries a real deadlock and commits each transaction exactly once", async () => {
    const service = injector.get(TransactionRetryService);
    const aLocked = deferred();
    const bLocked = deferred();
    const walletA = "GDEADLOCKRETRYAAAA".padEnd(56, "A");
    const walletB = "GDEADLOCKRETRYBBBB".padEnd(56, "B");

    const runA = service.runInTransaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(101)`;
        aLocked.resolve();
        await bLocked.promise;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(102)`;
        return tx.user.create({
          data: { walletAddress: walletA, walletHash: "sha256:deadlock-retry-a" },
        });
      },
      { operation: "int-deadlock-a", baseDelayMs: 10, maxDelayMs: 50 },
    );

    const runB = service.runInTransaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(102)`;
        bLocked.resolve();
        await aLocked.promise;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(101)`;
        return tx.user.create({
          data: { walletAddress: walletB, walletHash: "sha256:deadlock-retry-b" },
        });
      },
      { operation: "int-deadlock-b", baseDelayMs: 10, maxDelayMs: 50 },
    );

    const [userA, userB] = await Promise.all([runA, runB]);

    expect(userA.walletAddress).toBe(walletA);
    expect(userB.walletAddress).toBe(walletB);
    // Exactly one row per transaction: the aborted first attempt's insert
    // was rolled back, not committed alongside the retry's.
    expect(await db.prisma.user.count()).toBe(2);

    // At least one of the two transactions was aborted and retried.
    const diagnostics = service.recentDiagnostics();
    expect(diagnostics.length).toBeGreaterThanOrEqual(1);
    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.outcome === "succeeded_after_retry" &&
          diagnostic.attemptDiagnostics.some(
            (attempt) => attempt.category === "deadlock",
          ),
      ),
    ).toBe(true);
  });

  it("does not retry a unique-constraint violation inside a transaction", async () => {
    const service = injector.get(TransactionRetryService);
    const wallet = "GDEADLOCKRETRYDUPE".padEnd(56, "C");

    await db.prisma.user.create({
      data: { walletAddress: wallet, walletHash: "sha256:deadlock-retry-dupe" },
    });

    await expect(
      service.runInTransaction(
        async (tx) =>
          tx.user.create({
            data: { walletAddress: wallet, walletHash: "sha256:deadlock-retry-dupe-2" },
          }),
        { operation: "int-deadlock-dupe" },
      ),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(await db.prisma.user.count()).toBe(1);
  });

  it("surfaces a stable exhausted status when the budget is spent", async () => {
    const service = injector.get(TransactionRetryService);

    // Two transactions that will deadlock on every attempt: each run
    // re-enters the same opposite-order lock acquisition, so the retry
    // budget is spent on real deadlocks rather than a scripted error.
    const attempt = () =>
      service.runInTransaction(
        async (tx) => {
          const first = deferred();
          const second = deferred();
          const other = service.runInTransaction(
            async (otherTx) => {
              await otherTx.$executeRaw`SELECT pg_advisory_xact_lock(202)`;
              second.resolve();
              await first.promise;
              await otherTx.$executeRaw`SELECT pg_advisory_xact_lock(201)`;
            },
            { operation: "int-deadlock-other", maxAttempts: 1, allowRetry: false },
          );
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(201)`;
          first.resolve();
          await second.promise;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(202)`;
          await other;
        },
        { operation: "int-deadlock-exhaust", maxAttempts: 1 },
      );

    await expect(attempt()).rejects.toBeInstanceOf(TransactionRetryExhaustedError);
  });
});

import {
  RequestAbortedError,
  currentRequestSignal,
  guardTransactionsAgainstAbort,
  runWithRequestSignal,
  throwIfRequestAborted,
  withAbortGuard,
} from "./request-abort";

describe("request-abort context", () => {
  it("has no signal outside a request and does not throw", () => {
    expect(currentRequestSignal()).toBeUndefined();
    expect(() => throwIfRequestAborted()).not.toThrow();
  });

  it("exposes the signal across async continuations", async () => {
    const controller = new AbortController();
    await runWithRequestSignal(controller.signal, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      expect(currentRequestSignal()).toBe(controller.signal);
    });
  });

  it("throws RequestAbortedError once the signal aborts", async () => {
    const controller = new AbortController();
    await runWithRequestSignal(controller.signal, async () => {
      expect(() => throwIfRequestAborted()).not.toThrow();
      controller.abort();
      expect(() => throwIfRequestAborted()).toThrow(RequestAbortedError);
    });
  });

  it("isolates concurrent requests from one another", async () => {
    const a = new AbortController();
    const b = new AbortController();
    const seen: Record<string, boolean | undefined> = {};

    await Promise.all([
      runWithRequestSignal(a.signal, async () => {
        a.abort();
        await new Promise((resolve) => setImmediate(resolve));
        seen.a = currentRequestSignal()?.aborted;
      }),
      runWithRequestSignal(b.signal, async () => {
        await new Promise((resolve) => setImmediate(resolve));
        seen.b = currentRequestSignal()?.aborted;
      }),
    ]);

    expect(seen).toEqual({ a: true, b: false });
  });
});

describe("withAbortGuard", () => {
  function fakeTx() {
    return {
      payment: { findMany: jest.fn(async () => ["row"]) },
      $queryRaw: jest.fn(async () => [1]),
    };
  }

  it("passes model and raw queries through while not aborted", async () => {
    const tx = fakeTx();
    const guarded = withAbortGuard(tx, new AbortController().signal);

    await expect(guarded.payment.findMany()).resolves.toEqual(["row"]);
    await expect(guarded.$queryRaw()).resolves.toEqual([1]);
  });

  it("refuses to issue any further query after the abort", () => {
    const tx = fakeTx();
    const controller = new AbortController();
    const guarded = withAbortGuard(tx, controller.signal);

    controller.abort();

    expect(() => guarded.payment.findMany()).toThrow(RequestAbortedError);
    expect(() => guarded.$queryRaw()).toThrow(RequestAbortedError);
    expect(tx.payment.findMany).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("guardTransactionsAgainstAbort", () => {
  type Tx = { payment: { update: () => Promise<string> } };

  /** Models Prisma: commit when the callback resolves, roll back when it throws. */
  function fakeClient() {
    const tx: Tx = { payment: { update: jest.fn(async () => "updated") } };
    const outcome = { committed: 0, rolledBack: 0 };
    const client = {
      $transaction: jest.fn(async (arg: unknown) => {
        if (typeof arg !== "function") {
          return Promise.all(arg as Promise<unknown>[]);
        }
        try {
          const result = await (arg as (t: Tx) => Promise<unknown>)(tx);
          outcome.committed += 1;
          return result;
        } catch (error) {
          outcome.rolledBack += 1;
          throw error;
        }
      }),
    };
    guardTransactionsAgainstAbort(client);
    const run = (arg: unknown) =>
      (client.$transaction as unknown as (a: unknown) => Promise<unknown>)(arg);
    return { run, tx, outcome };
  }

  it("leaves transactions untouched outside a request", async () => {
    const { run, outcome } = fakeClient();

    const result = await run((t: Tx) => t.payment.update());

    expect(result).toBe("updated");
    expect(outcome).toEqual({ committed: 1, rolledBack: 0 });
  });

  it("commits a transaction that finishes before any abort", async () => {
    const { run, outcome } = fakeClient();
    const controller = new AbortController();

    const result = await runWithRequestSignal(controller.signal, () =>
      run((t: Tx) => t.payment.update()),
    );

    expect(result).toBe("updated");
    expect(outcome).toEqual({ committed: 1, rolledBack: 0 });
  });

  it("does not start a transaction for an already-aborted request", async () => {
    const { run, outcome } = fakeClient();
    const controller = new AbortController();
    controller.abort();
    const work = jest.fn();

    await expect(
      runWithRequestSignal(controller.signal, () => run(work)),
    ).rejects.toBeInstanceOf(RequestAbortedError);

    expect(work).not.toHaveBeenCalled();
    expect(outcome).toEqual({ committed: 0, rolledBack: 0 });
  });

  it("stops follow-on statements and rolls back when aborted mid-transaction", async () => {
    const { run, tx, outcome } = fakeClient();
    const controller = new AbortController();
    const afterAbort = jest.fn();

    await expect(
      runWithRequestSignal(controller.signal, () =>
        run(async (t: Tx) => {
          await t.payment.update();
          controller.abort(); // client disconnects between statements
          await t.payment.update();
          afterAbort();
        }),
      ),
    ).rejects.toBeInstanceOf(RequestAbortedError);

    expect(tx.payment.update).toHaveBeenCalledTimes(1);
    expect(afterAbort).not.toHaveBeenCalled();
    expect(outcome).toEqual({ committed: 0, rolledBack: 1 });
  });

  it("rolls back rather than commits when aborted during the final statement", async () => {
    const { run, outcome } = fakeClient();
    const controller = new AbortController();

    await expect(
      runWithRequestSignal(controller.signal, () =>
        run(async () => {
          controller.abort();
          return "done";
        }),
      ),
    ).rejects.toBeInstanceOf(RequestAbortedError);

    expect(outcome).toEqual({ committed: 0, rolledBack: 1 });
  });

  it("only checks batch transactions before they start", async () => {
    const { run } = fakeClient();
    const controller = new AbortController();

    await expect(
      runWithRequestSignal(controller.signal, () => run([Promise.resolve(1)])),
    ).resolves.toEqual([1]);

    controller.abort();
    await expect(
      runWithRequestSignal(controller.signal, () => run([Promise.resolve(1)])),
    ).rejects.toBeInstanceOf(RequestAbortedError);
  });
});

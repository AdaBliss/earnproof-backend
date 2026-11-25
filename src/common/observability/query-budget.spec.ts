import {
  QUERY_BUDGETS,
  QueryBudgetExceededError,
  QueryCounter,
  assertWithinBudget,
  countingClient,
  installQueryCounting,
  queryCountingEnabled,
  runWithQueryCounter,
} from "./query-budget";

describe("QueryCounter", () => {
  it("counts recorded operations and exposes their names", () => {
    const counter = new QueryCounter();
    counter.record("organization.findMany");
    counter.record("issuer.count");
    expect(counter.count).toBe(2);
    expect(counter.operations).toEqual(["organization.findMany", "issuer.count"]);
    counter.reset();
    expect(counter.count).toBe(0);
  });
});

describe("assertWithinBudget", () => {
  const counterOf = (n: number, label = "issuer.count") => {
    const counter = new QueryCounter();
    for (let i = 0; i < n; i += 1) counter.record(label);
    return counter;
  };

  it("passes at exactly the budget (boundary)", () => {
    expect(() => assertWithinBudget("issuers.list", counterOf(QUERY_BUDGETS["issuers.list"]))).not.toThrow();
  });

  it("fails one operation over the budget", () => {
    expect(() =>
      assertWithinBudget("issuers.list", counterOf(QUERY_BUDGETS["issuers.list"] + 1)),
    ).toThrow(QueryBudgetExceededError);
  });

  it("names the budget, the count and collapses repeats so an N+1 is obvious", () => {
    let error: Error | undefined;
    try {
      assertWithinBudget("organizations.list", counterOf(27, "issuer.count"));
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toContain('"organizations.list"');
    expect(error?.message).toContain("27 operations");
    expect(error?.message).toContain("issuer.count x27");
    expect(error?.message).toContain("N+1");
  });

  it("documents a positive budget for every targeted list path", () => {
    expect(Object.keys(QUERY_BUDGETS).sort()).toEqual([
      "api-keys.list",
      "issuers.list",
      "issuers.listPublic",
      "organizations.list",
      "payments.list",
      "proofs.list",
      "webhooks.list",
      "webhooks.listDeliveries",
    ]);
    for (const budget of Object.values(QUERY_BUDGETS)) {
      expect(budget).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(budget)).toBe(true);
    }
  });
});

describe("countingClient", () => {
  function fake() {
    return {
      organization: {
        findMany: jest.fn().mockResolvedValue([{ id: "o1" }]),
        count: jest.fn().mockResolvedValue(1),
      },
      issuer: { count: jest.fn().mockResolvedValue(4) },
      $queryRaw: jest.fn().mockResolvedValue([1]),
      $transaction: jest.fn(async (arg: unknown) =>
        typeof arg === "function" ? (arg as (tx: unknown) => unknown)({ payment: { create: jest.fn() } }) : arg,
      ),
      someFlag: true,
    };
  }

  it("counts delegate calls and passes results through unchanged", async () => {
    const counter = new QueryCounter();
    const client = countingClient(fake(), counter);

    await expect(client.organization.findMany()).resolves.toEqual([{ id: "o1" }]);
    await expect(client.issuer.count()).resolves.toBe(4);

    expect(counter.operations).toEqual(["organization.findMany", "issuer.count"]);
  });

  it("counts raw queries and passes plain properties through", async () => {
    const counter = new QueryCounter();
    const client = countingClient(fake(), counter);

    await client.$queryRaw();
    expect(client.someFlag).toBe(true);
    expect(counter.operations).toEqual(["$queryRaw"]);
  });

  it("includes queries made inside an interactive transaction", async () => {
    const counter = new QueryCounter();
    const client = countingClient(fake(), counter);

    await client.$transaction(async (tx: { payment: { create: () => Promise<unknown> } }) => {
      await tx.payment.create();
    });

    expect(counter.operations).toEqual(["$transaction", "payment.create"]);
  });

  it("keeps `this` bound so delegate methods still work", async () => {
    class Delegate {
      private readonly rows = [1, 2, 3];
      findMany() {
        return Promise.resolve(this.rows);
      }
    }
    const counter = new QueryCounter();
    const client = countingClient({ thing: new Delegate() }, counter);
    await expect(client.thing.findMany()).resolves.toEqual([1, 2, 3]);
  });

  it("detects an N+1 loop: the count grows with the page size", async () => {
    const run = async (pageSize: number) => {
      const counter = new QueryCounter();
      const client = countingClient(fake(), counter);
      const orgs = await client.organization.findMany();
      // The regression this guards against: one query per row.
      await Promise.all(Array.from({ length: pageSize }, () => client.issuer.count()));
      void orgs;
      return counter.count;
    };

    expect(await run(1)).toBeLessThan(await run(50));
    const bad = new QueryCounter();
    const client = countingClient(fake(), bad);
    await Promise.all(Array.from({ length: 50 }, () => client.issuer.count()));
    expect(() => assertWithinBudget("organizations.list", bad)).toThrow(QueryBudgetExceededError);
  });
});

describe("runtime instrumentation (opt-in)", () => {
  it("is disabled unless explicitly enabled, including in production", () => {
    expect(queryCountingEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(queryCountingEnabled({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(false);
    expect(queryCountingEnabled({ QUERY_BUDGET_INSTRUMENTATION: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(queryCountingEnabled({ QUERY_BUDGET_INSTRUMENTATION: "true" } as NodeJS.ProcessEnv)).toBe(true);
  });

  function patched() {
    const client = {
      organization: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    installQueryCounting(client, ["Organization"]);
    return client;
  }

  it("counts operations made inside a counter scope", async () => {
    const client = patched();
    const { counter } = await runWithQueryCounter(async () => {
      await client.organization.findMany();
      await client.organization.count();
      await client.$queryRaw();
    });
    expect(counter.operations).toEqual(["organization.findMany", "organization.count", "$queryRaw"]);
  });

  it("keeps concurrent scopes separate", async () => {
    const client = patched();
    const [a, b] = await Promise.all([
      runWithQueryCounter(async () => {
        await client.organization.findMany();
      }),
      runWithQueryCounter(async () => {
        await client.organization.findMany();
        await new Promise((r) => setTimeout(r, 2));
        await client.organization.count();
      }),
    ]);
    expect(a.counter.count).toBe(1);
    expect(b.counter.count).toBe(2);
  });

  it("is a no-op, and does not throw, outside any counter scope", async () => {
    const client = patched();
    await expect(client.organization.findMany()).resolves.toEqual([]);
  });

  it("ignores models the client does not have", () => {
    expect(() => installQueryCounting({}, ["Nope"])).not.toThrow();
  });
});

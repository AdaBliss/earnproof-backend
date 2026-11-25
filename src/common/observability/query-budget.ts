import { AsyncLocalStorage } from "async_hooks";

/**
 * Prisma query-count budgets for list endpoints.
 *
 * A list endpoint's query count must be a constant of its code, never a function
 * of the page size. The classic regression is an N+1: a loop that issues one
 * extra query per row of the page ("count the issuers of each organization"),
 * which is invisible at page size 2 in review and a latency incident at page size
 * 100 in production. This module makes the count measurable, gives each list path
 * an explicit documented budget, and lets tests fail when a path exceeds it.
 *
 * A "query" here is one Prisma client operation (`model.method(...)` or a raw
 * `$queryRaw`-style call). That is the unit an N+1 loop multiplies, and it is
 * deterministic where SQL statement counts are not (they vary with Prisma's
 * relation-load strategy). See docs/query-budgets.md.
 */

/**
 * The budget for each targeted list path: the maximum number of Prisma
 * operations a single call may issue, for ANY page size.
 *
 * Changing a number is a deliberate review decision, never a way to make a
 * failing test pass: first ask why the path needs another query.
 */
export const QUERY_BUDGETS = {
  /** findMany + count + one grouped issuer count for the whole page. */
  "organizations.list": 3,
  /** findMany + count. */
  "issuers.list": 2,
  "issuers.listPublic": 2,
  /** findMany only; cursor pagination needs no total. */
  "payments.list": 1,
  "proofs.list": 1,
  /** One query; scope assignments are a nested select, not a per-key lookup. */
  "api-keys.list": 1,
  "webhooks.list": 1,
  /** Ownership check + findMany. */
  "webhooks.listDeliveries": 2,
} as const;

export type QueryBudgetName = keyof typeof QUERY_BUDGETS;

/** Counts operations. Labels are `model.method` names, never arguments or data. */
export class QueryCounter {
  private readonly labels: string[] = [];

  record(label: string): void {
    this.labels.push(label);
  }

  get count(): number {
    return this.labels.length;
  }

  /** The recorded operations, for failure messages. Safe: names only. */
  get operations(): readonly string[] {
    return this.labels;
  }

  reset(): void {
    this.labels.length = 0;
  }
}

/** Thrown by {@link assertWithinBudget}. */
export class QueryBudgetExceededError extends Error {
  constructor(
    readonly budgetName: QueryBudgetName,
    readonly budget: number,
    readonly counter: QueryCounter,
  ) {
    super(
      `Query budget exceeded for "${budgetName}": ${counter.count} operations ` +
        `(budget ${budget}). Operations: ${summarise(counter.operations)}. ` +
        `A count that grows with page size is an N+1.`,
    );
    this.name = "QueryBudgetExceededError";
  }
}

/** Collapses repeats so an N+1 reads as `issuer.count x25`, not 25 lines. */
function summarise(operations: readonly string[]): string {
  const tally = new Map<string, number>();
  for (const op of operations) tally.set(op, (tally.get(op) ?? 0) + 1);
  return [...tally.entries()]
    .map(([op, n]) => (n > 1 ? `${op} x${n}` : op))
    .join(", ");
}

export function assertWithinBudget(
  name: QueryBudgetName,
  counter: QueryCounter,
): void {
  const budget = QUERY_BUDGETS[name];
  if (counter.count > budget) {
    throw new QueryBudgetExceededError(name, budget, counter);
  }
}

// ─── Counting wrapper (tests, and any caller holding a client) ───────────────

/**
 * Returns a view of `client` that records every operation into `counter`.
 *
 * Model delegates (`client.organization`) and top-level `$`-methods
 * (`client.$queryRaw`) are counted; `$transaction` callbacks receive a counted
 * transaction client, so queries inside an interactive transaction are included.
 * Non-function properties pass through untouched. The wrapped client behaves
 * exactly like the original.
 */
export function countingClient<T extends object>(
  client: T,
  counter: QueryCounter,
): T {
  const wrapDelegate = (model: string, delegate: object): object =>
    new Proxy(delegate, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function" || typeof prop !== "string") return value;
        return (...args: unknown[]) => {
          counter.record(`${model}.${prop}`);
          return Reflect.apply(value, target, args);
        };
      },
    });

  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string") return value;

      if (prop === "$transaction" && typeof value === "function") {
        return (arg: unknown, ...rest: unknown[]) => {
          counter.record("$transaction");
          if (typeof arg === "function") {
            return Reflect.apply(value, target, [
              (tx: object) =>
                (arg as (tx: object) => unknown)(countingClient(tx, counter)),
              ...rest,
            ]);
          }
          return Reflect.apply(value, target, [arg, ...rest]);
        };
      }

      if (typeof value === "function") {
        if (!prop.startsWith("$")) return value;
        return (...args: unknown[]) => {
          counter.record(prop);
          return Reflect.apply(value, target, args);
        };
      }

      if (
        !prop.startsWith("$") &&
        typeof value === "object" &&
        value !== null
      ) {
        return wrapDelegate(prop, value);
      }
      return value;
    },
  });
}

// ─── Runtime instrumentation (opt in; off by default) ───────────────────────

const active = new AsyncLocalStorage<QueryCounter>();

/** Runs `fn` with a fresh counter bound to its async context. */
export async function runWithQueryCounter<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; counter: QueryCounter }> {
  const counter = new QueryCounter();
  const result = await active.run(counter, fn);
  return { result, counter };
}

/** The operation methods patched on each delegate. */
const COUNTED_METHODS = [
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
] as const;

const RAW_METHODS = ["$queryRaw", "$executeRaw", "$queryRawUnsafe", "$executeRawUnsafe"] as const;

/**
 * Patches `client` so operations performed inside {@link runWithQueryCounter} are
 * counted.
 *
 * Overhead when no counter is active is a single `AsyncLocalStorage.getStore()`
 * per operation; and this is only installed when explicitly enabled (see
 * {@link queryCountingEnabled}), so production pays nothing by default.
 *
 * Operations on an interactive-transaction client are not counted here (that is
 * a different object); use {@link countingClient} when a transaction must be
 * included.
 */
export function installQueryCounting(
  client: object,
  modelNames: readonly string[],
): void {
  const host = client as Record<string, unknown>;

  for (const model of modelNames) {
    const delegate = host[lowerFirst(model)] as Record<string, unknown> | undefined;
    if (!delegate || typeof delegate !== "object") continue;
    for (const method of COUNTED_METHODS) {
      const original = delegate[method];
      if (typeof original !== "function") continue;
      delegate[method] = (...args: unknown[]) => {
        active.getStore()?.record(`${lowerFirst(model)}.${method}`);
        return Reflect.apply(original, delegate, args);
      };
    }
  }

  for (const method of RAW_METHODS) {
    const original = host[method];
    if (typeof original !== "function") continue;
    host[method] = (...args: unknown[]) => {
      active.getStore()?.record(method);
      return Reflect.apply(original, client, args);
    };
  }
}

/**
 * Whether runtime instrumentation is on. Explicit opt-in only: absent or any
 * value other than "true" leaves the client untouched, including in production.
 */
export function queryCountingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.QUERY_BUDGET_INSTRUMENTATION === "true";
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

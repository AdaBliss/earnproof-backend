import { AsyncLocalStorage } from "async_hooks";

/**
 * Request-scoped cancellation.
 *
 * When an HTTP client disconnects, the work started on its behalf should stop.
 * The interceptor binds the request's `AbortSignal` here for the duration of the
 * handler, so any code on the async call chain (Prisma transactions in
 * particular) can observe cancellation without every service threading a signal
 * through its signatures.
 */
const storage = new AsyncLocalStorage<AbortSignal>();

/**
 * Raised when work is abandoned because the client went away. It is a
 * cancellation, not a failure: the exception filter maps it to a non-5xx status
 * and it must not be logged or counted as an internal error.
 */
export class RequestAbortedError extends Error {
  readonly code = "REQUEST_ABORTED";
  constructor() {
    super("The request was aborted by the client");
    this.name = "RequestAbortedError";
  }
}

export function runWithRequestSignal<T>(signal: AbortSignal, fn: () => T): T {
  return storage.run(signal, fn);
}

/** The current request's signal, or `undefined` outside a request. */
export function currentRequestSignal(): AbortSignal | undefined {
  return storage.getStore();
}

/**
 * Throws {@link RequestAbortedError} if the current request was aborted.
 * A no-op outside a request (jobs, scripts), so shared code can call it freely.
 */
export function throwIfRequestAborted(): void {
  if (storage.getStore()?.aborted) {
    throw new RequestAbortedError();
  }
}

/**
 * Wraps a Prisma client so every query first checks for cancellation.
 *
 * This is the bounded fallback for the fact that the Prisma driver exposes no
 * way to cancel a statement already sent to the database: an in-flight
 * statement runs to completion, but no further statement is issued once the
 * request is aborted. Inside an interactive transaction the resulting throw
 * rolls the transaction back, so it never ends half-applied.
 */
export function withAbortGuard<T extends object>(client: T, signal: AbortSignal): T {
  const check = () => {
    if (signal.aborted) throw new RequestAbortedError();
  };

  const guardFunction = (fn: (...args: unknown[]) => unknown, self: unknown) =>
    new Proxy(fn, {
      apply(target, _thisArg, args) {
        check();
        return Reflect.apply(target, self, args);
      },
    });

  const guardDelegate = (delegate: object): object =>
    new Proxy(delegate, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        return typeof value === "function"
          ? guardFunction(value as (...args: unknown[]) => unknown, target)
          : value;
      },
    });

  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value === "function") {
        return guardFunction(value as (...args: unknown[]) => unknown, target);
      }
      // Model delegates (`tx.payment`) are objects of query methods.
      if (
        typeof prop === "string" &&
        !prop.startsWith("$") &&
        typeof value === "object" &&
        value !== null
      ) {
        return guardDelegate(value);
      }
      return value;
    },
  });
}

interface TransactionHost {
  $transaction: (arg: never, ...rest: never[]) => unknown;
}

/**
 * Replaces `client.$transaction` so transactions started on behalf of an
 * aborted request stop.
 *
 * Cancellation is cooperative and bounded: no new transaction starts for an
 * aborted request, no statement is issued after the abort inside an
 * interactive transaction, and a transaction whose request was aborted before
 * commit is rolled back (the callback throws). The outcome is therefore a clean
 * rollback or a completed commit, never a half-applied transaction. Outside a
 * request (jobs, scripts) there is no signal and behaviour is unchanged.
 *
 * Batch (array) transactions are only checked before they start: they are sent
 * to the database as a unit and cannot be interleaved with a check.
 */
export function guardTransactionsAgainstAbort(client: object): void {
  const host = client as unknown as TransactionHost;
  const original = host.$transaction.bind(client) as (
    arg: unknown,
    ...rest: unknown[]
  ) => unknown;

  host.$transaction = ((arg: unknown, ...rest: unknown[]) => {
    const signal = currentRequestSignal();
    if (!signal) return original(arg, ...rest);
    if (signal.aborted) return Promise.reject(new RequestAbortedError());
    if (typeof arg !== "function") return original(arg, ...rest);

    const callback = arg as (tx: object) => Promise<unknown>;
    return original(async (tx: object) => {
      const result = await callback(withAbortGuard(tx, signal));
      // Aborted during the final statement: roll back rather than commit work
      // nobody is waiting for.
      if (signal.aborted) throw new RequestAbortedError();
      return result;
    }, ...rest);
  }) as TransactionHost["$transaction"];
}

/**
 * Abort-aware deadlines for outbound operations.
 *
 * A timeout that only rejects the caller's promise does not stop the work: the
 * RPC call or CLI child keeps running and may later "succeed" with nobody
 * waiting. A deadline here is an `AbortSignal`, so it can be handed to the
 * operation itself (for example `execFile({ signal })`), which stops the work
 * and releases its resources.
 */

export type DeadlineKind = "deadline" | "cancelled";

/**
 * Raised when an operation was stopped before producing a trustworthy result,
 * either because its deadline elapsed or because its caller cancelled it.
 *
 * `message` is a fixed, safe string. It never embeds the underlying error text,
 * which for a CLI invocation can include argv such as a signing source.
 */
export class OperationAbortedError extends Error {
  readonly code = "OPERATION_ABORTED";

  constructor(
    readonly kind: DeadlineKind,
    readonly operation: string,
    readonly deadlineMs?: number,
  ) {
    super(
      kind === "deadline"
        ? `${operation} exceeded its ${deadlineMs}ms deadline`
        : `${operation} was cancelled`,
    );
    this.name = "OperationAbortedError";
  }
}

export interface DeadlineBounds {
  minMs: number;
  maxMs: number;
}

/**
 * Normalises a configured deadline: a non-finite, non-positive or missing value
 * falls back to the default, and anything else is clamped into the bounds so a
 * misconfiguration can neither disable the deadline nor make it unbounded.
 */
export function boundedDeadlineMs(
  value: unknown,
  fallbackMs: number,
  bounds: DeadlineBounds,
): number {
  const numeric = typeof value === "number" ? value : Number(value);
  const chosen =
    Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallbackMs;
  return Math.min(bounds.maxMs, Math.max(bounds.minMs, chosen));
}

export interface Deadline {
  /** Aborts when the deadline elapses or any parent signal aborts. */
  readonly signal: AbortSignal;
  /** True only when the deadline itself elapsed (not a parent cancellation). */
  readonly timedOut: boolean;
  /** Clears the timer. Always call in a `finally`. */
  dispose(): void;
  /**
   * The error describing why the signal aborted, or `undefined` while it has
   * not. Use after an operation settles to suppress a late result.
   */
  abortedError(operation: string): OperationAbortedError | undefined;
}

/**
 * Creates a deadline of `ms` milliseconds, additionally aborted by any of the
 * `parents` (request cancellation, worker shutdown, ...).
 */
export function createDeadline(
  ms: number,
  parents: ReadonlyArray<AbortSignal | undefined> = [],
): Deadline {
  const own = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    own.abort();
  }, ms);
  // A pending deadline must never keep the process alive.
  timer.unref?.();

  const live = parents.filter((p): p is AbortSignal => p !== undefined);
  const signal = live.length > 0 ? AbortSignal.any([own.signal, ...live]) : own.signal;

  return {
    signal,
    get timedOut() {
      return timedOut;
    },
    dispose: () => clearTimeout(timer),
    abortedError: (operation) => {
      if (!signal.aborted) return undefined;
      return new OperationAbortedError(
        timedOut ? "deadline" : "cancelled",
        operation,
        ms,
      );
    },
  };
}

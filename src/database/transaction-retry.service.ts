import { Inject, Injectable, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { backoffDelayMs } from "../common/resilience/backoff";
import { METRIC_NAMES } from "../common/observability/metrics.catalog";
import { MetricsRegistry } from "../common/observability/metrics.registry";
import { OperationalLogger } from "../common/observability/operational-logger";
import { redactError } from "../common/observability/redaction";
import {
  classifyDatabaseError,
  type DatabaseErrorCategory,
} from "./database-error-classification";
import { PrismaService } from "./prisma.service";

/**
 * Thrown when a transaction failed with a retryable database error on every
 * permitted attempt.
 *
 * The `status` field is the stable operation status callers and the global
 * exception filter branch on: it is the same string for every exhausted
 * retry, regardless of which database error ended the last attempt, so a
 * client can treat "the database kept conflicting, try again later" as one
 * condition instead of parsing whichever Postgres error happened to fire
 * last. The underlying error is preserved as `cause` for server-side
 * diagnosis and never leaves the process in a response body.
 */
export class TransactionRetryExhaustedError extends Error {
  readonly status = "retry_exhausted" as const;
  readonly operation: string;
  readonly attempts: number;
  readonly lastCategory: DatabaseErrorCategory;
  readonly lastPrismaCode?: string;

  constructor(
    operation: string,
    attempts: number,
    lastCategory: DatabaseErrorCategory,
    lastPrismaCode: string | undefined,
    cause: unknown,
  ) {
    super(
      `Database transaction "${operation}" failed after ${attempts} attempts ` +
        `(last failure: ${lastCategory}).`,
      { cause },
    );
    this.name = "TransactionRetryExhaustedError";
    this.operation = operation;
    this.attempts = attempts;
    this.lastCategory = lastCategory;
    this.lastPrismaCode = lastPrismaCode;
  }
}

/** One failed attempt inside a retried transaction, as recorded for diagnosis. */
export interface TransactionRetryAttemptDiagnostic {
  /** 1-based attempt number. */
  readonly attempt: number;
  readonly category: DatabaseErrorCategory;
  /** Redacted failure message — never a raw error string. */
  readonly redactedError: string;
  /** Jittered delay waited before the next attempt, when one followed. */
  readonly delayMs?: number;
}

/** Terminal outcome of a transaction that went through the retry wrapper. */
export type TransactionRetryOutcome =
  | "succeeded_after_retry"
  | "retry_exhausted"
  | "failed_non_retryable";

/**
 * Redacted diagnostics for one transaction that needed at least one retry
 * or failed outright.
 *
 * A first-attempt success records nothing: there is nothing to diagnose.
 * Everything recorded here is safe to retain — the operation name is a
 * bounded caller-supplied label, the category is a closed enum value, and
 * the error text passed through the same redaction as operational logs.
 * Correlation to a request happens through the log line, not this record.
 */
export interface TransactionRetryDiagnostic {
  readonly operation: string;
  readonly outcome: TransactionRetryOutcome;
  /** Total attempts made, including the final one. */
  readonly attempts: number;
  readonly attemptDiagnostics: readonly TransactionRetryAttemptDiagnostic[];
  readonly durationMs: number;
  readonly requestId?: string;
}

export interface TransactionRetryOptions {
  /**
   * Bounded caller-supplied name for the operation, e.g. `proof-revoke`.
   * Appears in log lines and diagnostics; must match
   * `/^[a-z][a-z0-9_-]{1,63}$/` so it can never become an unbounded label
   * or carry free-form content.
   */
  readonly operation: string;
  /** Maximum attempts including the first. Default 3, clamped to 1–10. */
  readonly maxAttempts?: number;
  /** Base delay for the jittered backoff, before doubling. Default 50 ms. */
  readonly baseDelayMs?: number;
  /** Ceiling the exponential term is clamped to. Default 1000 ms. */
  readonly maxDelayMs?: number;
  /**
   * Set to `false` when the callback performs non-idempotent work outside
   * the database (an outbound call, a file write): the transaction is then
   * attempted exactly once, however retryable the failure looks. Default
   * true — a rolled-back transaction has no durable effect, so re-running
   * a pure-database callback cannot duplicate committed work.
   */
  readonly allowRetry?: boolean;
  readonly isolationLevel?: Prisma.TransactionIsolationLevel;
  readonly maxWait?: number;
  readonly timeout?: number;
  /** Injected source of [0, 1) for the jitter; defaults to `Math.random`. */
  readonly random?: () => number;
  /** Injected sleep; defaults to a real timer. Tests inject a no-op. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Propagated to the log line and diagnostic for correlation. */
  readonly requestId?: string;
}

/** Defaults from {@link TransactionRetryOptions}, after clamping. */
export const TRANSACTION_RETRY_DEFAULTS = {
  maxAttempts: 3,
  baseDelayMs: 50,
  maxDelayMs: 1000,
} as const;

/** Hard bounds on the retry budget: a request-bound retry must end. */
export const TRANSACTION_RETRY_LIMITS = {
  minAttempts: 1,
  maxAttempts: 10,
} as const;

/** How many recent diagnostics are retained in memory. */
const MAX_DIAGNOSTICS = 100;

const OPERATION_NAME = /^[a-z][a-z0-9_-]{1,63}$/;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bounded, jittered retries for database transactions.
 *
 * Concurrent administrative and worker writes can deadlock under production
 * ordering; PostgreSQL aborts one of the two transactions, and the aborted
 * work is safe to re-run because the abort rolled the whole transaction
 * back — nothing from the failed attempt is committed, so a retry cannot
 * duplicate it.
 *
 * Determinism: the retry budget and the backoff schedule are fixed by the
 * options, the jitter source is injectable, and the sleep is injectable, so
 * a test with a fixed `random` and a no-op `sleep` observes an exact delay
 * sequence. Observability: every retry is logged with a redacted message,
 * counted on `database_transaction_retries_total` by closed category and
 * outcome labels, and recorded in a bounded in-memory diagnostic buffer.
 *
 * Authorization and privacy are untouched by construction: the callback
 * runs with the caller's own context inside the same transaction, an
 * authorisation failure is classified non-retryable and propagates
 * unchanged, and no diagnostic carries identifiers, payloads, or raw error
 * text.
 */
@Injectable()
export class TransactionRetryService {
  private readonly log = new OperationalLogger(TransactionRetryService.name);
  private readonly diagnostics: TransactionRetryDiagnostic[] = [];

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(MetricsRegistry)
    private readonly metrics?: MetricsRegistry,
  ) {}

  /**
   * Runs `fn` inside a Prisma interactive transaction, retrying the whole
   * transaction when it fails with a retryable database error.
   *
   * The callback receives the interactive-transaction client and must do
   * database work only (or pass `allowRetry: false`): a retry re-invokes
   * the callback from the start, and anything it did outside the
   * transaction would happen again.
   *
   * @throws The original error when it is not retryable, or retries are
   * disabled, or it fails on the first attempt with retries disabled.
   * @throws {@link TransactionRetryExhaustedError} when every permitted
   * attempt failed with a retryable error.
   */
  async runInTransaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options: TransactionRetryOptions,
  ): Promise<T> {
    const operation = validateOperation(options.operation);
    const maxAttempts = Math.min(
      Math.max(
        Math.floor(options.maxAttempts ?? TRANSACTION_RETRY_DEFAULTS.maxAttempts),
        TRANSACTION_RETRY_LIMITS.minAttempts,
      ),
      TRANSACTION_RETRY_LIMITS.maxAttempts,
    );
    const baseDelayMs = Math.max(
      0,
      options.baseDelayMs ?? TRANSACTION_RETRY_DEFAULTS.baseDelayMs,
    );
    const maxDelayMs = Math.max(
      0,
      options.maxDelayMs ?? TRANSACTION_RETRY_DEFAULTS.maxDelayMs,
    );
    const allowRetry = options.allowRetry ?? true;
    const random = options.random ?? Math.random;
    const sleep = options.sleep ?? defaultSleep;
    const requestId = options.requestId;

    const startedAt = Date.now();
    const attemptDiagnostics: TransactionRetryAttemptDiagnostic[] = [];
    let lastClassification: ReturnType<typeof classifyDatabaseError> | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.prisma.$transaction(fn, {
          ...(options.isolationLevel !== undefined
            ? { isolationLevel: options.isolationLevel }
            : {}),
          ...(options.maxWait !== undefined ? { maxWait: options.maxWait } : {}),
          ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
        });

        if (attemptDiagnostics.length > 0) {
          this.recordDiagnostic({
            operation,
            outcome: "succeeded_after_retry",
            attempts: attempt,
            attemptDiagnostics,
            durationMs: Date.now() - startedAt,
            requestId,
          });
        }
        return result;
      } catch (error) {
        const classification = classifyDatabaseError(error);
        lastClassification = classification;
        const redacted = redactError(error);
        const isLastAttempt = attempt >= maxAttempts;

        if (!allowRetry || !classification.retryable || isLastAttempt) {
          attemptDiagnostics.push({
            attempt,
            category: classification.category,
            redactedError: redacted,
          });
          this.recordDiagnostic({
            operation,
            outcome:
              classification.retryable && allowRetry
                ? "retry_exhausted"
                : "failed_non_retryable",
            attempts: attempt,
            attemptDiagnostics,
            durationMs: Date.now() - startedAt,
            requestId,
          });

          if (classification.retryable && allowRetry) {
            this.recordRetryMetric(classification.category, "exhausted");
            this.log.error(
              `Transaction "${operation}" exhausted ${attempt} attempts`,
              error,
              requestId ? { requestId } : undefined,
            );
            throw new TransactionRetryExhaustedError(
              operation,
              attempt,
              classification.category,
              classification.prismaCode,
              error,
            );
          }

          // Non-retryable failures propagate exactly as thrown: the caller
          // (and the global exception filter) sees the original error, with
          // its original type and status, not a retry wrapper.
          throw error;
        }

        const delayMs = backoffDelayMs(attempt, {
          baseMs: baseDelayMs,
          maxDelayMs,
          random,
        });
        attemptDiagnostics.push({
          attempt,
          category: classification.category,
          redactedError: redacted,
          delayMs,
        });
        this.recordRetryMetric(classification.category, "retried");
        this.log.warn(
          `Retrying transaction "${operation}" after ${classification.category} ` +
            `(attempt ${attempt} of ${maxAttempts}, retrying in ${delayMs}ms): ${redacted}`,
          requestId ? { requestId } : undefined,
        );
        await sleep(delayMs);
      }
    }

    // Unreachable: the loop always returns or throws. Kept so the compiler
    // — and a reader — can see the loop has no fall-through.
    throw new TransactionRetryExhaustedError(
      operation,
      maxAttempts,
      lastClassification?.category ?? "unknown",
      lastClassification?.prismaCode,
      new Error("Retry loop ended without a result"),
    );
  }

  /**
   * Recent retry diagnostics, oldest first. Bounded to the last
   * {@link MAX_DIAGNOSTICS} entries; returns a copy.
   */
  recentDiagnostics(): TransactionRetryDiagnostic[] {
    return [...this.diagnostics];
  }

  private recordDiagnostic(diagnostic: TransactionRetryDiagnostic): void {
    this.diagnostics.push(diagnostic);
    if (this.diagnostics.length > MAX_DIAGNOSTICS) {
      this.diagnostics.shift();
    }
  }

  /**
   * Best-effort metric emission: observability must never fail the
   * operation it observes. A registry that has not registered the counter
   * (a module wired without the observability module) logs a warning
   * instead of breaking the transaction.
   */
  private recordRetryMetric(
    category: DatabaseErrorCategory,
    outcome: "retried" | "exhausted",
  ): void {
    if (!this.metrics) return;
    try {
      this.metrics.increment(METRIC_NAMES.databaseTransactionRetriesTotal, {
        db_error_category: category,
        retry_outcome: outcome,
      });
    } catch (error) {
      this.log.warn(
        `Could not record transaction retry metric: ${redactError(error)}`,
      );
    }
  }
}

function validateOperation(operation: string): string {
  if (!OPERATION_NAME.test(operation)) {
    throw new Error(
      `Invalid transaction operation name "${operation}": use 2-64 lowercase ` +
        `letters, digits, "-" or "_", starting with a letter.`,
    );
  }
  return operation;
}

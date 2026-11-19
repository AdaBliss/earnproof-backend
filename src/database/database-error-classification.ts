import { Prisma } from "@prisma/client";

/**
 * Closed set of database failure kinds a transaction can end in.
 *
 * The distinction that matters most is retryable vs not: a deadlock, a
 * serialisation failure, a lock timeout, or a lost connection are all
 * transient properties of *concurrent* execution, and re-running the same
 * transaction against the same committed state is safe. A constraint
 * violation or a missing row is a property of the *data*, and re-running
 * will fail the same way every time.
 *
 * Categories are diagnostic only — they are what lands in the retry log line
 * and the retry metric — never a client-facing value, so a new category is
 * not a contract change.
 */
export type DatabaseErrorCategory =
  | "deadlock"
  | "serialization_failure"
  | "lock_timeout"
  | "connection"
  | "pool_timeout"
  | "conflict"
  | "not_found"
  | "unknown";

/** Result of classifying one thrown value as a database failure. */
export interface DatabaseErrorClassification {
  /** True only for transient failures where a re-run can succeed. */
  readonly retryable: boolean;
  readonly category: DatabaseErrorCategory;
  /** Prisma error code (e.g. `P2034`), when the failure came from Prisma. */
  readonly prismaCode?: string;
  /** PostgreSQL SQLSTATE (e.g. `40P01`), when one could be recovered. */
  readonly sqlState?: string;
}

/**
 * Prisma codes that are transient: the database, not the request, is at
 * fault, and the same transaction may succeed a moment later.
 *
 * - P2034 — "Transaction failed due to a write conflict or a deadlock."
 *   Prisma collapses PostgreSQL's deadlock (40P01) and serialisation
 *   failure (40001) into this one code; the message is the only
 *   distinguisher, and both are retryable either way.
 * - P2024 — timed out fetching a connection from the pool.
 * - P1001 / P1002 / P1008 / P1017 — the server could not be reached, or a
 *   live connection dropped. P1000 (bad credentials) and P1010 (access
 *   denied) are deliberately absent: retrying an authentication failure
 *   cannot succeed.
 */
const RETRYABLE_PRISMA_CODES: Readonly<Record<string, DatabaseErrorCategory>> = {
  P2034: "deadlock",
  P2024: "pool_timeout",
  P1001: "connection",
  P1002: "connection",
  P1008: "connection",
  P1017: "connection",
};

/** Prisma codes that describe the data, not the execution: never retryable. */
const NON_RETRYABLE_PRISMA_CODES: Readonly<Record<string, DatabaseErrorCategory>> = {
  P2002: "conflict",
  P2003: "conflict",
  P2025: "not_found",
};

/**
 * PostgreSQL SQLSTATEs that are transient, for failures that arrive outside
 * Prisma's own code table — raw-query failures (P2010 embeds the SQLSTATE in
 * its message) and driver-level errors that carry a bare `code`.
 */
const RETRYABLE_SQL_STATES: Readonly<Record<string, DatabaseErrorCategory>> = {
  "40P01": "deadlock",
  "40001": "serialization_failure",
  "55P03": "lock_timeout",
  "53300": "connection",
  "08001": "connection",
  "08004": "connection",
  "08006": "connection",
  "57P01": "connection",
};

/** Matches a bare SQLSTATE token inside a longer message (P2010 embeds one). */
const SQL_STATE_IN_MESSAGE = /\b(40P01|40001|55P03|53300|08001|08004|08006|57P01)\b/;

/**
 * Classifies a thrown value as a database failure.
 *
 * Never throws, and never classifies a non-database error as retryable: an
 * authorisation failure, a validation error, or any other application error
 * is `unknown` / not retryable, so the retry loop can never turn a refused
 * operation into a retried one. An unrecognised database error is likewise
 * not retryable — retrying something unclassified is how a permanent failure
 * becomes a slow one.
 */
export function classifyDatabaseError(error: unknown): DatabaseErrorClassification {
  if (error && typeof error === "object") {
    const record = error as { code?: unknown; message?: unknown; meta?: unknown };

    // ── Prisma known-request errors ──────────────────────────────────────
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const prismaCode = error.code;

      const retryableCategory = RETRYABLE_PRISMA_CODES[prismaCode];
      if (retryableCategory) {
        // P2034 covers both deadlock and serialisation failure; the message
        // is the only distinguisher, and the category is diagnostic only.
        const category =
          prismaCode === "P2034" && !/deadlock/i.test(error.message)
            ? "serialization_failure"
            : retryableCategory;
        return { retryable: true, category, prismaCode };
      }

      const terminalCategory = NON_RETRYABLE_PRISMA_CODES[prismaCode];
      if (terminalCategory) {
        return { retryable: false, category: terminalCategory, prismaCode };
      }

      // P2010 ("Raw query failed") embeds the PostgreSQL SQLSTATE in its
      // message and in `meta.code`; classify on that rather than on P2010
      // itself, which says nothing about the underlying failure.
      if (prismaCode === "P2010") {
        const fromMeta = extractSqlState(record.meta);
        const fromMessage = fromMeta ?? extractSqlState(error.message);
        if (fromMessage) {
          return classifySqlState(fromMessage, prismaCode);
        }
      }

      return { retryable: false, category: "unknown", prismaCode };
    }

    // ── Bare driver / raw errors carrying a SQLSTATE as `code` ───────────
    if (typeof record.code === "string") {
      const sqlState = record.code;
      if (RETRYABLE_SQL_STATES[sqlState]) {
        return classifySqlState(sqlState);
      }
      if (/^[0-9A-Z]{2}[0-9A-Z]{3}$/.test(sqlState)) {
        return { retryable: false, category: "unknown", sqlState };
      }
    }

    // ── Errors whose message embeds a SQLSTATE ───────────────────────────
    if (typeof record.message === "string") {
      const sqlState = extractSqlState(record.message);
      if (sqlState) {
        return classifySqlState(sqlState);
      }
    }
  }

  return { retryable: false, category: "unknown" };
}

function extractSqlState(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.match(SQL_STATE_IN_MESSAGE)?.[1];
  }
  if (value && typeof value === "object") {
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string" && RETRYABLE_SQL_STATES[code]) return code;
    if (typeof code === "string" && /^[0-9A-Z]{2}[0-9A-Z]{3}$/.test(code)) return code;
  }
  return undefined;
}

function classifySqlState(
  sqlState: string,
  prismaCode?: string,
): DatabaseErrorClassification {
  const category = RETRYABLE_SQL_STATES[sqlState];
  if (category) {
    return { retryable: true, category, sqlState, prismaCode };
  }
  return { retryable: false, category: "unknown", sqlState, prismaCode };
}

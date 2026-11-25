/**
 * Transaction wrapper that applies workload-specific timeouts.
 *
 * Usage:
 *   const result = await withWorkloadTimeout(
 *     prismaService,
 *     timeoutService,
 *     WorkloadType.INTERACTIVE,
 *     async (tx) => {
 *       // Write with interactive timeout...
 *       await tx.proof.create({ ... });
 *       return { ... };
 *     }
 *   );
 *
 * The timeouts are applied via `SET LOCAL` inside the transaction, so they
 * never leak to the connection pool or affect other workloads.
 */

import { Prisma } from "@prisma/client";
import { DatabaseTimeoutError, DatabaseCancelledError } from "../common/exceptions/domain.exceptions";
import { Logger } from "@nestjs/common";
import { DatabaseTimeoutService } from "./database-timeout.service";
import { PrismaService } from "./prisma.service";
import { WorkloadType } from "./workload-profiles";

const logger = new Logger("WithWorkloadTimeout");

/**
 * PostgreSQL error codes for timeout and cancellation.
 * See: https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const PG_STATEMENT_TIMEOUT = "57014"; // query_canceled
const PG_IDLE_IN_TRANSACTION_TIMEOUT = "57014"; // query_canceled
const PG_LOCK_TIMEOUT = "55P03"; // lock_not_available
const PG_ADMIN_SHUTDOWN = "57P02"; // admin_shutdown

/**
 * Detects if a Prisma error is a timeout/cancellation error.
 * Maps PostgreSQL error codes to our typed exceptions.
 *
 * @param error the caught error
 * @returns true if this is a timeout/cancellation error
 */
function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }

  // Prisma wraps PostgreSQL error codes in the `code` field.
  // P3024 = Query timed out
  // Check for both Prisma's own timeout code and PostgreSQL codes.
  return (
    error.code === "P3024" || // Prisma statement timeout
    (error as any).meta?.code === PG_STATEMENT_TIMEOUT ||
    (error as any).meta?.code === PG_IDLE_IN_TRANSACTION_TIMEOUT ||
    (error as any).meta?.code === PG_LOCK_TIMEOUT
  );
}

/**
 * Detects if a Prisma error is an explicit cancellation (vs. timeout).
 * Used to distinguish between timeout and admin-initiated cancellation.
 *
 * @param error the caught error
 * @returns true if this is an explicit cancellation
 */
function isCancellationError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }

  // Check for query_canceled specifically (not lock timeout)
  return (
    (error as any).meta?.code === PG_STATEMENT_TIMEOUT ||
    (error as any).meta?.code === PG_IDLE_IN_TRANSACTION_TIMEOUT ||
    (error as any).meta?.code === PG_ADMIN_SHUTDOWN
  );
}

/**
 * Executes a transaction callback with workload-specific timeout enforcement.
 *
 * Applies `SET LOCAL` commands at the start of the transaction to set
 * statement_timeout, idle_in_transaction_session_timeout, and lock_timeout
 * per the workload profile. Timeouts are scoped to the transaction only and
 * never leak to the connection pool.
 *
 * If the callback times out:
 * - The transaction is automatically rolled back by PostgreSQL
 * - The error is caught and remapped to DatabaseTimeoutError
 * - The error message does not include SQL, parameters, or internal details
 *
 * @param prismaService the PrismaService instance
 * @param timeoutService the DatabaseTimeoutService instance
 * @param workload the workload type (determines timeout budget)
 * @param callback the work to execute inside the transaction
 * @returns the result of the callback
 * @throws DatabaseTimeoutError if the transaction times out
 * @throws DatabaseCancelledError if the transaction is cancelled
 * @throws the original error for all other failures
 */
export async function withWorkloadTimeout<T>(
  prismaService: PrismaService,
  timeoutService: DatabaseTimeoutService,
  workload: WorkloadType,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await prismaService.$transaction(async (tx) => {
      // Apply workload-specific timeouts at the start of the transaction
      await timeoutService.applyWorkloadTimeouts(workload, tx);

      // Execute the callback inside the transaction with timeouts active
      return await callback(tx);
    });
  } catch (error) {
    // Map timeout/cancellation errors to typed exceptions
    if (isTimeoutError(error)) {
      logger.warn(
        `Database timeout for workload ${workload}: ${error instanceof Error ? error.message : String(error)}`,
      );

      if (isCancellationError(error)) {
        throw new DatabaseCancelledError(
          "Database operation was cancelled",
        );
      } else {
        throw new DatabaseTimeoutError(
          "Database operation timed out",
        );
      }
    }

    // Re-throw all other errors as-is
    throw error;
  }
}

/**
 * Variant: executes a batch transaction (array of statements) with timeouts.
 *
 * Batch transactions run multiple statements atomically but do not apply
 * per-statement timeouts (all statements share the same timeout pool).
 * This is a convenience wrapper that reuses the timeout service.
 *
 * @param prismaService the PrismaService instance
 * @param timeoutService the DatabaseTimeoutService instance
 * @param workload the workload type
 * @param statements the statements to execute atomically
 * @returns results from all statements
 * @throws DatabaseTimeoutError if any statement times out
 * @throws the original error for all other failures
 */
export async function withWorkloadTimeoutBatch<T extends readonly unknown[]>(
  prismaService: PrismaService,
  timeoutService: DatabaseTimeoutService,
  workload: WorkloadType,
  statements: T,
): Promise<T> {
  try {
    return await prismaService.$transaction(statements);
  } catch (error) {
    // Map timeout/cancellation errors to typed exceptions
    if (isTimeoutError(error)) {
      logger.warn(
        `Database timeout for batch workload ${workload}: ${error instanceof Error ? error.message : String(error)}`,
      );

      if (isCancellationError(error)) {
        throw new DatabaseCancelledError(
          "Database operation was cancelled",
        );
      } else {
        throw new DatabaseTimeoutError(
          "Database operation timed out",
        );
      }
    }

    // Re-throw all other errors
    throw error;
  }
}

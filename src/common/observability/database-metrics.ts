/**
 * Metrics for database statement timeout enforcement.
 *
 * Tracks:
 * - Number of timeouts per workload
 * - Number of cancellations per workload
 * - Number of rollbacks due to timeout
 * - Statement duration against its budget
 *
 * All metrics use low-cardinality labels (workload, outcome) to prevent
 * cardinality explosions. Never includes user, tenant, query, or table names.
 */

import { WorkloadType } from "../../database/workload-profiles";

/**
 * Metric definitions for database timeout enforcement.
 * These should be registered with the MetricsRegistry on startup.
 */
export const DatabaseMetricDefinitions = {
  /**
   * Total count of database statement timeouts per workload.
   *
   * Incremented when a transaction exceeds its statement_timeout and is
   * cancelled by PostgreSQL. Labels: workload (interactive, job, migration, report).
   */
  databaseTimeoutTotal: {
    name: "database_timeout_total",
    help: "Total count of database statement timeouts",
    labelNames: ["workload"] as const,
  },

  /**
   * Total count of database cancellations per workload.
   *
   * Incremented when a transaction is explicitly cancelled (CANCEL query or
   * admin shutdown). Different from timeout (error code P3024/57014).
   * Labels: workload.
   */
  databaseCancellationTotal: {
    name: "database_cancellation_total",
    help: "Total count of database operation cancellations",
    labelNames: ["workload"] as const,
  },

  /**
   * Total count of transactions rolled back due to timeout per workload.
   *
   * When a statement times out, PostgreSQL automatically rolls back the
   * transaction. This metric counts how many times that happened.
   * Labels: workload.
   */
  databaseTimeoutRollbackTotal: {
    name: "database_timeout_rollback_total",
    help: "Total count of transactions rolled back due to timeout",
    labelNames: ["workload"] as const,
  },

  /**
   * Statement execution duration histogram per workload.
   *
   * Measures how long database statements take, bucketed so we can observe
   * whether statements are completing within their budget. Labels: workload, outcome.
   * Outcome: "success", "timeout", "error".
   */
  databaseStatementDuration: {
    name: "database_statement_duration_ms",
    help: "Database statement execution duration",
    labelNames: ["workload", "outcome"] as const,
    buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000],
  },

  /**
   * Idle-in-transaction violations per workload.
   *
   * Incremented when a transaction exceeds its idle_in_transaction_session_timeout
   * while holding locks without progress. Labels: workload.
   */
  databaseIdleInTransactionTimeoutTotal: {
    name: "database_idle_in_transaction_timeout_total",
    help: "Total count of idle-in-transaction timeouts",
    labelNames: ["workload"] as const,
  },

  /**
   * Lock wait timeouts per workload.
   *
   * Incremented when a statement exceeds lock_timeout while waiting for a
   * lock held by another session. Labels: workload.
   */
  databaseLockTimeoutTotal: {
    name: "database_lock_timeout_total",
    help: "Total count of lock acquisition timeouts",
    labelNames: ["workload"] as const,
  },
};

/**
 * Metric observation helper: records a successful statement with duration.
 *
 * @param metrics the metrics registry
 * @param workload the workload type
 * @param durationMs the statement duration in milliseconds
 */
export function recordDatabaseStatementSuccess(
  metrics: any,
  workload: WorkloadType,
  durationMs: number,
): void {
  if (!metrics || !metrics.databaseStatementDuration) {
    return; // Metrics not initialized
  }

  try {
    metrics.databaseStatementDuration.observe(
      { workload, outcome: "success" },
      durationMs,
    );
  } catch (error) {
    // Silently ignore metric observation errors
  }
}

/**
 * Metric observation helper: records a statement timeout.
 *
 * @param metrics the metrics registry
 * @param workload the workload type
 * @param durationMs the statement duration before timeout
 */
export function recordDatabaseStatementTimeout(
  metrics: any,
  workload: WorkloadType,
  durationMs: number,
): void {
  if (!metrics) {
    return;
  }

  try {
    if (metrics.databaseTimeoutTotal) {
      metrics.databaseTimeoutTotal.inc({ workload });
    }
    if (metrics.databaseStatementDuration) {
      metrics.databaseStatementDuration.observe(
        { workload, outcome: "timeout" },
        durationMs,
      );
    }
  } catch (error) {
    // Silently ignore metric observation errors
  }
}

/**
 * Metric observation helper: records a statement error.
 *
 * @param metrics the metrics registry
 * @param workload the workload type
 * @param durationMs the statement duration before error
 */
export function recordDatabaseStatementError(
  metrics: any,
  workload: WorkloadType,
  durationMs: number,
): void {
  if (!metrics || !metrics.databaseStatementDuration) {
    return;
  }

  try {
    metrics.databaseStatementDuration.observe(
      { workload, outcome: "error" },
      durationMs,
    );
  } catch (error) {
    // Silently ignore metric observation errors
  }
}

/**
 * Metric observation helper: records a cancellation.
 *
 * @param metrics the metrics registry
 * @param workload the workload type
 */
export function recordDatabaseCancellation(
  metrics: any,
  workload: WorkloadType,
): void {
  if (!metrics || !metrics.databaseCancellationTotal) {
    return;
  }

  try {
    metrics.databaseCancellationTotal.inc({ workload });
  } catch (error) {
    // Silently ignore
  }
}

/**
 * Metric observation helper: records a rollback due to timeout.
 *
 * @param metrics the metrics registry
 * @param workload the workload type
 */
export function recordDatabaseTimeoutRollback(
  metrics: any,
  workload: WorkloadType,
): void {
  if (!metrics || !metrics.databaseTimeoutRollbackTotal) {
    return;
  }

  try {
    metrics.databaseTimeoutRollbackTotal.inc({ workload });
  } catch (error) {
    // Silently ignore
  }
}

/**
 * Metric observation helper: records an idle-in-transaction timeout.
 *
 * @param metrics the metrics registry
 * @param workload the workload type
 */
export function recordDatabaseIdleInTransactionTimeout(
  metrics: any,
  workload: WorkloadType,
): void {
  if (!metrics || !metrics.databaseIdleInTransactionTimeoutTotal) {
    return;
  }

  try {
    metrics.databaseIdleInTransactionTimeoutTotal.inc({ workload });
  } catch (error) {
    // Silently ignore
  }
}

/**
 * Metric observation helper: records a lock timeout.
 *
 * @param metrics the metrics registry
 * @param workload the workload type
 */
export function recordDatabaseLockTimeout(
  metrics: any,
  workload: WorkloadType,
): void {
  if (!metrics || !metrics.databaseLockTimeoutTotal) {
    return;
  }

  try {
    metrics.databaseLockTimeoutTotal.inc({ workload });
  } catch (error) {
    // Silently ignore
  }
}

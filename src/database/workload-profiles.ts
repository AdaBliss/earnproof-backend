/**
 * Database workload classification and timeout profiles.
 *
 * Each workload type (interactive request, background job, migration, report)
 * is assigned a separate budget with its own statement, idle-in-transaction,
 * and lock timeouts. Timeouts are applied transaction-locally via `SET LOCAL`
 * so they never leak to pooled connections or other workloads.
 */

/** Workload classification. */
export enum WorkloadType {
  /** HTTP request handler (user-facing, SLA-driven, sub-second targets). */
  INTERACTIVE = "interactive",

  /** Background job (batch, unattended, may retry, tuning per job). */
  JOB = "job",

  /** One-time deployment migration (high latency tolerance, schema locks OK). */
  MIGRATION = "migration",

  /** Bulk export, batch analytics (heavy scanning, aggregation, time-boxed). */
  REPORT = "report",
}

/**
 * Timeout settings for one workload, all in milliseconds.
 */
export interface WorkloadProfile {
  /** Maximum duration of a single SQL statement before cancellation. */
  statementTimeoutMs: number;

  /** Maximum duration a transaction may remain idle without progress. */
  idleInTransactionTimeoutMs: number;

  /** Maximum duration to wait for a lock before timing out. */
  lockTimeoutMs: number;
}

/** Mapping of workload type to its timeout profile. */
export type WorkloadProfiles = Record<WorkloadType, WorkloadProfile>;

/**
 * Validates a workload profile: all timeouts must be positive integers.
 * Throws if any timeout is invalid (zero, negative, non-integer).
 *
 * @param profile the profile to validate
 * @param workload the workload name (for error messages)
 * @throws Error if any timeout is invalid
 */
export function validateWorkloadProfile(
  profile: WorkloadProfile,
  workload: WorkloadType,
): void {
  const checks: Array<[string, number]> = [
    ["statementTimeoutMs", profile.statementTimeoutMs],
    ["idleInTransactionTimeoutMs", profile.idleInTransactionTimeoutMs],
    ["lockTimeoutMs", profile.lockTimeoutMs],
  ];

  for (const [name, value] of checks) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(
        `Invalid workload profile for ${workload}: ${name} must be a positive integer, got ${value}`,
      );
    }
  }
}

/**
 * Validates all workload profiles.
 *
 * @param profiles all workload profiles
 * @throws Error if any profile is invalid
 */
export function validateAllWorkloadProfiles(profiles: WorkloadProfiles): void {
  for (const [workload, profile] of Object.entries(profiles)) {
    validateWorkloadProfile(profile, workload as WorkloadType);
  }
}

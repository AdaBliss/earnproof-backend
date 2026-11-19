/**
 * Health check contracts.
 *
 * The three probes answer deliberately different questions, and conflating them
 * is what this module exists to prevent:
 *
 * - Liveness  — "is this process running?"  Never touches an external system.
 * - Readiness — "can this process serve dependent work right now?"
 * - Diagnostics — "what exactly is wrong?"  Authorized callers only.
 */

import type { ClockSkewSnapshot } from "./clock-skew-monitor.service";
import type { DatabasePoolSnapshot } from "./database-pool-monitor.service";

/**
 * Stable, safe status codes.
 *
 * Callers (and alerting rules) branch on these rather than on error strings, so
 * they must stay stable even when the underlying failure text changes. Raw
 * driver errors are never surfaced: a connection error commonly embeds the DSN,
 * including credentials.
 */
export const DependencyStatus = {
  /** Dependency answered within its timeout. */
  OK: "ok",
  /** Dependency answered, but reported a problem. */
  DEGRADED: "degraded",
  /** Dependency did not answer within its timeout. */
  TIMEOUT: "timeout",
  /** Dependency answered with an error, or could not be reached. */
  ERROR: "error",
  /** Dependency is intentionally switched off by configuration. */
  DISABLED: "disabled",
  /** Dependency is enabled but not configured well enough to be probed. */
  NOT_CONFIGURED: "not_configured",
} as const;

export type DependencyStatusValue =
  (typeof DependencyStatus)[keyof typeof DependencyStatus];

/**
 * Whether a dependency's health can make the service unready.
 *
 * Only REQUIRED dependencies gate readiness. Marking an optional dependency as
 * required is how an unrelated outage (say, Horizon) wrongly takes an entire
 * API offline, including routes that never touch it.
 */
export const DependencyKind = {
  REQUIRED: "required",
  OPTIONAL: "optional",
} as const;

export type DependencyKindValue =
  (typeof DependencyKind)[keyof typeof DependencyKind];

/** A single dependency probe result. */
export interface DependencyResult {
  name: string;
  kind: DependencyKindValue;
  status: DependencyStatusValue;
  /** Observed probe duration in milliseconds. Omitted when not probed. */
  durationMs?: number;
  /**
   * A stable, non-identifying reason code (never a raw error message).
   * Present only for non-OK statuses.
   */
  reason?: string;
  /** True when this result was served from cache rather than freshly probed. */
  cached?: boolean;
  /** Age of a cached result, in milliseconds. */
  ageMs?: number;
  /**
   * Per-circuit state, present only on the circuit-breaker dependency.
   *
   * Deliberately typed as counts-and-state records: it carries circuit names
   * and numbers, never a transaction payload, an address, or an error body, so
   * it is safe to render in the authorized diagnostics response.
   */
  circuits?: CircuitDiagnostic[];
  /**
   * Clock skew detail, present only on the `clock_skew` diagnostics entry.
   * Numbers, source names and stable codes only — see clock-skew-monitor.
   */
  clockSkew?: ClockSkewSnapshot;
  /**
   * Pool saturation detail, present only on the `database_pool` entry.
   * Counts, ratios, latencies, thresholds and a runbook link only — never
   * a connection string, credential, host, or query text.
   */
  pool?: DatabasePoolSnapshot;
}

/** Privacy-safe view of one circuit for the diagnostics endpoint. */
export interface CircuitDiagnostic {
  name: string;
  state: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  probeSuccesses: number;
  probesInFlight: number;
  openCount: number;
  cooldownRemainingMs: number;
}

/** Aggregate readiness verdict. */
export interface ReadinessResult {
  status: "ready" | "not_ready";
  dependencies: DependencyResult[];
}

/**
 * What an unauthenticated caller may see of readiness: the aggregate verdict
 * only.
 *
 * This is the entire public readiness contract. Dependency names, kinds,
 * statuses, reason codes, probe durations, cache ages, circuit detail, and
 * clock-skew snapshots are diagnostics: they name infrastructure and its
 * current state, which is exactly the reconnaissance an unauthenticated
 * caller must not get. They stay behind the authorized diagnostics endpoint.
 * `requestId` is an opaque correlation reference (echoed from the
 * `X-Request-ID` header when the request carried one); it identifies the
 * request in server-side logs, never a person or a dependency.
 */
export interface PublicReadinessResult {
  status: "ready" | "not_ready";
  service: string;
  /** ISO-8601 UTC timestamp of when the probe was answered. */
  timestamp: string;
  /** Opaque correlation reference, present only when the request carried one. */
  requestId?: string;
}

/** Name reported by every public health probe. */
export const HEALTH_SERVICE_NAME = "earnproof-api";

/**
 * Project a full readiness result onto its public view.
 *
 * Pure and total: the output is built field by field from the aggregate
 * verdict, so no dependency detail can leak through by being added to
 * {@link DependencyResult} later. The result is deterministic in shape and
 * bounded to four fields.
 */
export function toPublicReadiness(
  result: ReadinessResult,
  requestId?: string,
): PublicReadinessResult {
  const publicResult: PublicReadinessResult = {
    status: result.status,
    service: HEALTH_SERVICE_NAME,
    timestamp: new Date().toISOString(),
  };
  if (requestId !== undefined) {
    publicResult.requestId = requestId;
  }
  return publicResult;
}

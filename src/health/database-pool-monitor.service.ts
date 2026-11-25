import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as os from "os";

import { PrismaService } from "../database/prisma.service";
import {
  METRIC_NAMES,
  registerCoreMetrics,
} from "../common/observability/metrics.catalog";
import { MetricsRegistry } from "../common/observability/metrics.registry";

/**
 * Database connection-pool saturation monitor.
 *
 * Operators need early warning when requests or jobs approach connection
 * exhaustion. This monitor reads the Prisma client's own pool metrics
 * (`$metrics.json()`, enabled by the `metrics` preview feature in
 * `prisma/schema.prisma`) and turns them into a bounded, privacy-safe
 * snapshot: pool occupancy, wait latency, timeout counts, thresholds, and
 * the runbook link.
 *
 * Privacy contract:
 * - Only counts, ratios, and latencies are exposed. The connection string
 *   is parsed for the numeric `connection_limit` only; host, database,
 *   username, and password never leave this module, and no query text is
 *   ever read or emitted.
 * - Metric labels come from the closed vocabulary in `metric-labels.ts`.
 *
 * Note: Prisma marks the `metrics` preview feature deprecated in 6.19.3;
 * if a future Prisma removes `$metrics`, this monitor degrades to its
 * `unknown` state (and the probe-duration fallback) rather than failing.
 * Revisit the metrics source on the Prisma upgrade that removes it.
 *
 * Determinism and bounds:
 * - Every snapshot is derived from the latest metrics payload plus bounded
 *   in-memory counters. The probe-latency fallback buffer holds at most
 *   `maxWaitSamples` entries. Sampling is single-flight and rate-limited by
 *   `minSampleIntervalMs`, and every metrics read is timeout-bounded, so a
 *   hung database cannot hang a readiness poll.
 *
 * Hysteresis (readiness):
 * - A single saturated sample never blocks readiness. Only
 *   `sustainSamples` consecutive saturated samples latch
 *   `sustainedCritical`, and only that latched state blocks readiness.
 *   `clearSamples` consecutive healthy samples clear the latch. An
 *   `unknown` sample (metrics unavailable) neither advances nor clears the
 *   latch: stale data cannot clear an alert, and missing data cannot raise
 *   one.
 *
 * Failure modes:
 * - Prisma's `$metrics` call requires a reachable database in this client
 *   version (the engine validates connectivity on first use). When the
 *   database is down the snapshot is `unknown` with a stable reason code —
 *   readiness already fails on the database probe itself in that state, so
 *   the pool monitor never has to guess.
 */

export type DatabasePoolStatus =
  | "ok"
  | "warning"
  | "critical"
  | "unknown"
  | "disabled";

export interface DatabasePoolThresholds {
  warnUtilization: number;
  criticalUtilization: number;
  warnWaitMs: number;
  criticalWaitMs: number;
  sustainSamples: number;
  clearSamples: number;
}

export interface DatabasePoolSettings extends DatabasePoolThresholds {
  enabled: boolean;
  sampleTimeoutMs: number;
  minSampleIntervalMs: number;
  maxWaitSamples: number;
  runbook: string;
}

export interface DatabasePoolSnapshot {
  status: DatabasePoolStatus;
  /** Stable reason code; never a raw error, URL, or query text. */
  reason?: string;
  pool: {
    /** Effective per-process connection limit (numeric only). */
    limit: number;
    open: number | null;
    busy: number | null;
    idle: number | null;
    /** Queries currently waiting for a connection, when reported. */
    waiting: number | null;
    /** busy / limit, or open / limit when busy is unreported. */
    utilization: number | null;
  };
  wait: {
    p50Ms: number | null;
    p95Ms: number | null;
    meanMs: number | null;
    /** Observations behind the percentiles. */
    samples: number;
    source: "prisma_histogram" | "probe_duration" | null;
  };
  timeouts: { total: number; consecutive: number };
  thresholds: DatabasePoolThresholds;
  alert: {
    sustainedCritical: boolean;
    consecutiveSaturated: number;
    consecutiveHealthy: number;
    blocksReadiness: boolean;
  };
  runbook: string;
  sampledAt: string | null;
  sampleAgeMs: number | null;
}

/** Defaults. Every value is overridable through `databasePool.*` config. */
export const DATABASE_POOL_DEFAULTS: DatabasePoolSettings = {
  enabled: true,
  warnUtilization: 0.7,
  criticalUtilization: 0.9,
  warnWaitMs: 100,
  criticalWaitMs: 500,
  sustainSamples: 3,
  clearSamples: 2,
  sampleTimeoutMs: 2_000,
  minSampleIntervalMs: 1_000,
  maxWaitSamples: 120,
  runbook: "docs/runbooks/database-pool-saturation.md",
};

/** Prisma's default `connection_limit`: two per CPU plus one. */
export const DEFAULT_POOL_LIMIT_MULTIPLIER = 2;
export const MAX_POOL_LIMIT = 1_000;

export const DATABASE_POOL_RUNBOOK_DEFAULT =
  DATABASE_POOL_DEFAULTS.runbook;

/** Prisma metric names this monitor reads. */
export const PRISMA_POOL_METRICS = {
  open: "prisma_pool_connections_open",
  busy: "prisma_pool_connections_busy",
  idle: "prisma_pool_connections_idle",
  waiting: "prisma_client_queries_wait",
  waitHistogram: "prisma_client_queries_wait_histogram_ms",
} as const;

/** Stable reason codes. Nothing else is ever emitted as a reason. */
export const DATABASE_POOL_REASONS = {
  saturationWarning: "database_pool_saturation_warning",
  saturationCritical: "database_pool_saturation_critical",
  saturationSustained: "database_pool_saturation_sustained",
  metricsUnavailable: "database_pool_metrics_unavailable",
  sampleTimeout: "database_pool_sample_timeout",
  notSampled: "database_pool_not_sampled",
  monitorDisabled: "database_pool_monitor_disabled",
  monitorAbsent: "database_pool_monitor_absent",
} as const;

interface PrismaMetricsEntry {
  name: string;
  value?: number;
}

interface PrismaMetricsHistogram {
  name: string;
  buckets?: unknown;
  sum?: number;
  count?: number;
}

export interface PrismaMetricsJson {
  counters?: PrismaMetricsEntry[];
  gauges?: PrismaMetricsEntry[];
  histograms?: PrismaMetricsHistogram[];
}

type ConfigGetter = Pick<ConfigService, "get">;

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

function clampInt(value: number, min: number, max: number): number {
  const floored = Math.floor(value);
  if (!Number.isFinite(floored)) return min;
  return Math.min(max, Math.max(min, floored));
}

/**
 * Resolve and validate pool settings from configuration.
 *
 * Invalid values are clamped to their valid range instead of throwing: a
 * misconfigured threshold must degrade to a safe default, never fail boot.
 * The ordering invariant `warn < critical` is enforced deterministically.
 */
export function resolveDatabasePoolSettings(
  config: ConfigGetter,
): DatabasePoolSettings {
  const get = <T>(key: string, fallback: T): T =>
    (config.get<T>(`databasePool.${key}`) ?? fallback) as T;

  const enabled = get<boolean>("enabled", DATABASE_POOL_DEFAULTS.enabled);
  const warnUtilization = Math.min(
    0.9,
    Math.max(0.05, asFiniteNumber(get("warnUtilization", DATABASE_POOL_DEFAULTS.warnUtilization), DATABASE_POOL_DEFAULTS.warnUtilization)),
  );
  const criticalUtilization = Math.min(
    0.99,
    Math.max(
      warnUtilization + 0.05,
      asFiniteNumber(get("criticalUtilization", DATABASE_POOL_DEFAULTS.criticalUtilization), DATABASE_POOL_DEFAULTS.criticalUtilization),
    ),
  );
  const warnWaitMs = clampInt(
    asFiniteNumber(get("warnWaitMs", DATABASE_POOL_DEFAULTS.warnWaitMs), DATABASE_POOL_DEFAULTS.warnWaitMs),
    1,
    60_000,
  );
  const criticalWaitMs = Math.max(
    warnWaitMs + 1,
    clampInt(
      asFiniteNumber(get("criticalWaitMs", DATABASE_POOL_DEFAULTS.criticalWaitMs), DATABASE_POOL_DEFAULTS.criticalWaitMs),
      2,
      60_000,
    ),
  );

  return {
    enabled: enabled !== false,
    warnUtilization,
    criticalUtilization,
    warnWaitMs,
    criticalWaitMs,
    sustainSamples: clampInt(
      asFiniteNumber(get("sustainSamples", DATABASE_POOL_DEFAULTS.sustainSamples), DATABASE_POOL_DEFAULTS.sustainSamples),
      1,
      10,
    ),
    clearSamples: clampInt(
      asFiniteNumber(get("clearSamples", DATABASE_POOL_DEFAULTS.clearSamples), DATABASE_POOL_DEFAULTS.clearSamples),
      1,
      10,
    ),
    sampleTimeoutMs: clampInt(
      asFiniteNumber(get("sampleTimeoutMs", DATABASE_POOL_DEFAULTS.sampleTimeoutMs), DATABASE_POOL_DEFAULTS.sampleTimeoutMs),
      100,
      30_000,
    ),
    minSampleIntervalMs: clampInt(
      asFiniteNumber(get("minSampleIntervalMs", DATABASE_POOL_DEFAULTS.minSampleIntervalMs), DATABASE_POOL_DEFAULTS.minSampleIntervalMs),
      0,
      60_000,
    ),
    maxWaitSamples: clampInt(
      asFiniteNumber(get("maxWaitSamples", DATABASE_POOL_DEFAULTS.maxWaitSamples), DATABASE_POOL_DEFAULTS.maxWaitSamples),
      10,
      1_000,
    ),
    runbook:
      typeof get("runbook", DATABASE_POOL_DEFAULTS.runbook) === "string" &&
      (get("runbook", DATABASE_POOL_DEFAULTS.runbook) as string).trim() !== ""
        ? (get("runbook", DATABASE_POOL_DEFAULTS.runbook) as string)
        : DATABASE_POOL_DEFAULTS.runbook,
  };
}

/**
 * Effective per-process pool limit for a connection string.
 *
 * Reads only the numeric `connection_limit` query parameter. When absent or
 * invalid, Prisma's default (`2 * CPUs + 1`) applies. The URL itself — host,
 * credentials, database name — is never returned or logged.
 */
export function parsePoolLimit(
  databaseUrl: string | undefined,
  cpuCount: number = os.cpus().length,
): number {
  const fallback = clampInt(cpuCount * DEFAULT_POOL_LIMIT_MULTIPLIER + 1, 1, MAX_POOL_LIMIT);
  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") {
    return fallback;
  }
  try {
    const limit = Number(new URL(databaseUrl).searchParams.get("connection_limit"));
    if (!Number.isFinite(limit) || limit <= 0) return fallback;
    return clampInt(limit, 1, MAX_POOL_LIMIT);
  } catch {
    return fallback;
  }
}

function metricValue(
  metrics: PrismaMetricsJson,
  name: string,
): number | null {
  for (const group of [metrics.counters ?? [], metrics.gauges ?? []]) {
    for (const entry of group) {
      if (
        entry?.name === name &&
        typeof entry.value === "number" &&
        Number.isFinite(entry.value)
      ) {
        return entry.value;
      }
    }
  }
  return null;
}

/** Normalize a Prisma histogram's buckets to sorted [upperBound, count] pairs. */
export function normalizeHistogramBuckets(buckets: unknown): Array<[number, number]> {
  if (!Array.isArray(buckets)) {
    if (buckets !== null && typeof buckets === "object") {
      // Object form: { "<upperBound>": <count> }.
      return Object.entries(buckets as Record<string, unknown>)
        .map(([le, count]) => [Number(le), Number(count)] as [number, number])
        .filter(([le, count]) => Number.isFinite(le) && Number.isFinite(count) && count >= 0)
        .sort((a, b) => a[0] - b[0]);
    }
    return [];
  }
  const pairs: Array<[number, number]> = [];
  for (const bucket of buckets) {
    if (Array.isArray(bucket) && bucket.length >= 2) {
      const le = Number(bucket[0]);
      const count = Number(bucket[1]);
      if (Number.isFinite(le) && Number.isFinite(count) && count >= 0) {
        pairs.push([le, count]);
      }
    } else if (bucket !== null && typeof bucket === "object") {
      const record = bucket as Record<string, unknown>;
      const le = Number(record.le ?? record.upperBound ?? record.bucket);
      const count = Number(record.count ?? record.value);
      if (Number.isFinite(le) && Number.isFinite(count) && count >= 0) {
        pairs.push([le, count]);
      }
    }
  }
  return pairs.sort((a, b) => a[0] - b[0]);
}

/**
 * Quantile from cumulative histogram buckets.
 *
 * Returns the first bucket upper bound whose cumulative count reaches the
 * quantile, or null when the histogram is empty. Deterministic: equal inputs
 * always yield the same bound.
 */
export function percentileFromBuckets(
  buckets: Array<[number, number]>,
  quantile: number,
): number | null {
  if (buckets.length === 0) return null;
  const total = buckets.reduce((sum, [, count]) => sum + count, 0);
  if (total <= 0) return null;
  const target = Math.ceil(quantile * total);
  let cumulative = 0;
  for (const [le, count] of buckets) {
    cumulative += count;
    if (cumulative >= target) return le;
  }
  return buckets[buckets.length - 1][0];
}

/**
 * Instantaneous saturation classification.
 *
 * `critical` when utilization or wait latency reaches the critical
 * threshold; `warning` at the warn threshold; `ok` below both; `unknown`
 * when neither signal is observable. Boundary values belong to the worse
 * state: exactly at a threshold counts as breaching it.
 */
export function classifyPoolSaturation(
  utilization: number | null,
  waitP95Ms: number | null,
  thresholds: DatabasePoolThresholds,
): "ok" | "warning" | "critical" | "unknown" {
  if (utilization === null && waitP95Ms === null) return "unknown";
  if (
    (utilization !== null && utilization >= thresholds.criticalUtilization) ||
    (waitP95Ms !== null && waitP95Ms >= thresholds.criticalWaitMs)
  ) {
    return "critical";
  }
  if (
    (utilization !== null && utilization >= thresholds.warnUtilization) ||
    (waitP95Ms !== null && waitP95Ms >= thresholds.warnWaitMs)
  ) {
    return "warning";
  }
  return "ok";
}

class PoolSampleTimeoutError extends Error {
  constructor() {
    super("pool_sample_timeout");
    this.name = "PoolSampleTimeoutError";
  }
}

class PoolMetricsUnavailableError extends Error {
  constructor() {
    super("pool_metrics_unavailable");
    this.name = "PoolMetricsUnavailableError";
  }
}

@Injectable()
export class DatabasePoolMonitorService {
  private readonly logger = new Logger(DatabasePoolMonitorService.name);
  private readonly settings: DatabasePoolSettings;
  private readonly poolLimit: number;

  private lastSnapshot: DatabasePoolSnapshot | null = null;
  private lastSampledAtMs: number | null = null;
  private inFlight: Promise<DatabasePoolSnapshot> | null = null;

  private timeoutTotal = 0;
  private timeoutConsecutive = 0;
  private consecutiveSaturated = 0;
  private consecutiveHealthy = 0;
  private sustainedCritical = false;
  /** Bounded fallback wait-latency observations from successful probes. */
  private readonly probeWaitLatencies: number[] = [];

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly registry?: MetricsRegistry,
  ) {
    this.settings = resolveDatabasePoolSettings(config);
    this.poolLimit = parsePoolLimit(config.get<string>("databaseUrl"));
    if (this.registry) {
      // Idempotent: the global ObservabilityModule already registers the
      // catalog at boot; registering again is a no-op for identical defs.
      try {
        registerCoreMetrics(this.registry);
      } catch (error) {
        this.logger.warn(
          `Pool metrics catalog registration failed: ${error instanceof Error ? error.name : "unknown"}`,
        );
      }
    }
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  get thresholds(): DatabasePoolThresholds {
    const { warnUtilization, criticalUtilization, warnWaitMs, criticalWaitMs, sustainSamples, clearSamples } =
      this.settings;
    return { warnUtilization, criticalUtilization, warnWaitMs, criticalWaitMs, sustainSamples, clearSamples };
  }

  /** True only while a sustained critical saturation is latched. */
  blocksReadiness(): boolean {
    return this.settings.enabled && this.sustainedCritical;
  }

  /**
   * Sample the pool metrics and return the current snapshot.
   *
   * Single-flight and rate-limited by `minSampleIntervalMs`: concurrent or
   * rapid callers share one fresh-enough snapshot instead of issuing a
   * metrics read each. Never throws: every failure degrades to an `unknown`
   * snapshot with a stable reason code.
   */
  sample(nowMs: number = Date.now()): Promise<DatabasePoolSnapshot> {
    if (!this.settings.enabled) {
      return Promise.resolve(this.buildSnapshot("disabled", DATABASE_POOL_REASONS.monitorDisabled, nowMs, {
        p50Ms: null,
        p95Ms: null,
        meanMs: null,
        samples: 0,
        source: null,
      }));
    }
    if (
      this.lastSnapshot !== null &&
      this.lastSampledAtMs !== null &&
      nowMs - this.lastSampledAtMs < this.settings.minSampleIntervalMs
    ) {
      return Promise.resolve(this.refreshSnapshot(nowMs));
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.sampleOnce(nowMs).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Latest snapshot without sampling; `unknown` until the first sample. */
  snapshot(nowMs: number = Date.now()): DatabasePoolSnapshot {
    if (this.lastSnapshot) return this.refreshSnapshot(nowMs);
    return this.buildSnapshot(
      "unknown",
      DATABASE_POOL_REASONS.notSampled,
      nowMs,
      {
        p50Ms: null,
        p95Ms: null,
        meanMs: null,
        samples: 0,
        source: null,
      },
      undefined,
      null,
    );
  }

  /**
   * Feed one database-probe outcome into the monitor.
   *
   * A probe timeout is a failed connection acquisition, so it counts as a
   * timeout and as a saturated observation for hysteresis. A successful
   * probe only contributes its duration to the bounded fallback wait
   * buffer: acquiring one connection proves nothing about pool occupancy,
   * so it never advances or clears the saturation latch.
   */
  recordProbeOutcome(durationMs: number, timedOut: boolean): void {
    if (!this.settings.enabled) return;
    if (timedOut) {
      this.timeoutTotal += 1;
      this.timeoutConsecutive += 1;
      this.consecutiveHealthy = 0;
      this.consecutiveSaturated += 1;
      if (this.consecutiveSaturated >= this.settings.sustainSamples) {
        this.sustainedCritical = true;
      }
      this.emitTimeout();
      return;
    }
    this.timeoutConsecutive = 0;
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      this.probeWaitLatencies.push(durationMs);
      if (this.probeWaitLatencies.length > this.settings.maxWaitSamples) {
        this.probeWaitLatencies.splice(
          0,
          this.probeWaitLatencies.length - this.settings.maxWaitSamples,
        );
      }
    }
  }

  private async sampleOnce(nowMs: number): Promise<DatabasePoolSnapshot> {
    let metrics: PrismaMetricsJson;
    try {
      metrics = await this.readMetricsWithTimeout();
    } catch (error) {
      if (error instanceof PoolSampleTimeoutError) {
        this.timeoutTotal += 1;
        this.timeoutConsecutive += 1;
        this.emitTimeout();
        // A timed-out metrics read is not proof of saturation (the database
        // may simply be down, which readiness already reports), so it does
        // not advance the saturation latch — but it does break a healthy
        // streak, because an unobserved pool cannot clear an alert.
        this.consecutiveHealthy = 0;
        const snapshot = this.buildSnapshot("unknown", DATABASE_POOL_REASONS.sampleTimeout, nowMs, this.fallbackWait());
        this.storeSnapshot(snapshot, nowMs);
        return snapshot;
      }
      this.logger.warn(
        `Database pool metrics unavailable: ${error instanceof Error ? error.name : "unknown"}`,
      );
      this.consecutiveHealthy = 0;
      const snapshot = this.buildSnapshot("unknown", DATABASE_POOL_REASONS.metricsUnavailable, nowMs, this.fallbackWait());
      this.storeSnapshot(snapshot, nowMs);
      return snapshot;
    }

    const open = metricValue(metrics, PRISMA_POOL_METRICS.open);
    const busy = metricValue(metrics, PRISMA_POOL_METRICS.busy);
    const idle = metricValue(metrics, PRISMA_POOL_METRICS.idle);
    const waiting = metricValue(metrics, PRISMA_POOL_METRICS.waiting);

    const occupied = busy ?? open;
    const utilization =
      occupied === null
        ? null
        : Math.round((occupied / this.poolLimit) * 10_000) / 10_000;

    const wait = this.waitFromMetrics(metrics);
    const instantaneous = classifyPoolSaturation(utilization, wait.p95Ms, this.settings);
    this.advanceHysteresis(instantaneous);

    const status: DatabasePoolStatus = this.sustainedCritical
      ? "critical"
      : instantaneous;
    const reason =
      status === "critical"
        ? this.sustainedCritical
          ? DATABASE_POOL_REASONS.saturationSustained
          : DATABASE_POOL_REASONS.saturationCritical
        : status === "warning"
          ? DATABASE_POOL_REASONS.saturationWarning
          : undefined;

    const snapshot = this.buildSnapshot(status, reason, nowMs, wait, {
      open,
      busy,
      idle,
      waiting,
      utilization,
    });
    this.storeSnapshot(snapshot, nowMs);
    this.emitWait(wait, status);
    return snapshot;
  }

  private advanceHysteresis(
    instantaneous: "ok" | "warning" | "critical" | "unknown",
  ): void {
    if (instantaneous === "critical") {
      this.consecutiveSaturated += 1;
      this.consecutiveHealthy = 0;
      if (this.consecutiveSaturated >= this.settings.sustainSamples) {
        this.sustainedCritical = true;
      }
    } else if (instantaneous === "ok") {
      this.consecutiveHealthy += 1;
      this.consecutiveSaturated = 0;
      if (this.consecutiveHealthy >= this.settings.clearSamples) {
        this.sustainedCritical = false;
      }
    }
    // "warning" leaves both counters untouched: pressure persists, but a
    // warning alone neither sustains a critical latch nor clears one.
    // "unknown" is handled by the caller (healthy streak broken, latch kept).
  }

  private waitFromMetrics(
    metrics: PrismaMetricsJson,
  ): DatabasePoolSnapshot["wait"] {
    const histogram = (metrics.histograms ?? []).find(
      (entry) => entry?.name === PRISMA_POOL_METRICS.waitHistogram,
    );
    if (histogram) {
      const buckets = normalizeHistogramBuckets(histogram.buckets);
      const count =
        typeof histogram.count === "number" && Number.isFinite(histogram.count)
          ? histogram.count
          : buckets.reduce((sum, [, c]) => sum + c, 0);
      const mean =
        typeof histogram.sum === "number" &&
        Number.isFinite(histogram.sum) &&
        count > 0
          ? Math.round((histogram.sum / count) * 100) / 100
          : null;
      const p50 = percentileFromBuckets(buckets, 0.5);
      const p95 = percentileFromBuckets(buckets, 0.95);
      if (p50 !== null || p95 !== null || count > 0) {
        return { p50Ms: p50, p95Ms: p95, meanMs: mean, samples: count, source: "prisma_histogram" };
      }
    }
    return this.fallbackWait();
  }

  /** Wait latency from the bounded probe-duration buffer, if any. */
  private fallbackWait(): DatabasePoolSnapshot["wait"] {
    if (this.probeWaitLatencies.length === 0) {
      return { p50Ms: null, p95Ms: null, meanMs: null, samples: 0, source: null };
    }
    const sorted = [...this.probeWaitLatencies].sort((a, b) => a - b);
    const at = (quantile: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))];
    const mean =
      Math.round(
        (sorted.reduce((sum, value) => sum + value, 0) / sorted.length) * 100,
      ) / 100;
    return {
      p50Ms: at(0.5),
      p95Ms: at(0.95),
      meanMs: mean,
      samples: sorted.length,
      source: "probe_duration",
    };
  }

  private async readMetricsWithTimeout(): Promise<PrismaMetricsJson> {
    const metricsClient = (this.prisma as unknown as
      | { $metrics?: { json?: () => Promise<PrismaMetricsJson> } }
      | undefined)?.$metrics;
    if (!metricsClient || typeof metricsClient.json !== "function") {
      throw new PoolMetricsUnavailableError();
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new PoolSampleTimeoutError());
        }, this.settings.sampleTimeoutMs);
      });
      return await Promise.race([metricsClient.json(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private emitTimeout(): void {
    if (!this.registry) return;
    try {
      this.registry.increment(METRIC_NAMES.databasePoolTimeoutsTotal, {
        outcome: "timeout",
      });
    } catch {
      // Observability must never break health reporting.
    }
  }

  private emitWait(wait: DatabasePoolSnapshot["wait"], status: DatabasePoolStatus): void {
    if (!this.registry || wait.p95Ms === null) return;
    try {
      this.registry.observe(METRIC_NAMES.databasePoolWaitDurationMs, wait.p95Ms, {
        pool_status: status,
      });
    } catch {
      // Observability must never break health reporting.
    }
  }

  private storeSnapshot(snapshot: DatabasePoolSnapshot, nowMs: number): void {
    this.lastSnapshot = snapshot;
    this.lastSampledAtMs = nowMs;
  }

  /** Re-derive the mutable counters of the cached snapshot without re-reading metrics. */
  private refreshSnapshot(nowMs: number): DatabasePoolSnapshot {
    if (!this.lastSnapshot || this.lastSampledAtMs === null) {
      return this.snapshot(nowMs);
    }
    return {
      ...this.lastSnapshot,
      timeouts: { total: this.timeoutTotal, consecutive: this.timeoutConsecutive },
      alert: {
        sustainedCritical: this.sustainedCritical,
        consecutiveSaturated: this.consecutiveSaturated,
        consecutiveHealthy: this.consecutiveHealthy,
        blocksReadiness: this.blocksReadiness(),
      },
      sampleAgeMs: Math.max(0, nowMs - this.lastSampledAtMs),
    };
  }

  private buildSnapshot(
    status: DatabasePoolStatus,
    reason: string | undefined,
    nowMs: number,
    wait: DatabasePoolSnapshot["wait"],
    pool?: Partial<DatabasePoolSnapshot["pool"]>,
    sampledAtMs: number | null = nowMs,
  ): DatabasePoolSnapshot {
    return {
      status,
      ...(reason ? { reason } : {}),
      pool: {
        limit: this.poolLimit,
        open: pool?.open ?? null,
        busy: pool?.busy ?? null,
        idle: pool?.idle ?? null,
        waiting: pool?.waiting ?? null,
        utilization: pool?.utilization ?? null,
      },
      wait,
      timeouts: { total: this.timeoutTotal, consecutive: this.timeoutConsecutive },
      thresholds: this.thresholds,
      alert: {
        sustainedCritical: this.sustainedCritical,
        consecutiveSaturated: this.consecutiveSaturated,
        consecutiveHealthy: this.consecutiveHealthy,
        blocksReadiness: this.blocksReadiness(),
      },
      runbook: this.settings.runbook,
      sampledAt:
        sampledAtMs === null ? null : new Date(sampledAtMs).toISOString(),
      sampleAgeMs:
        sampledAtMs === null ? null : Math.max(0, nowMs - sampledAtMs),
    };
  }
}

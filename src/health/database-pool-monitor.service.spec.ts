import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { METRIC_NAMES, registerCoreMetrics } from "../common/observability/metrics.catalog";
import {
  CounterSnapshot,
  HistogramSnapshot,
  MetricsRegistry,
} from "../common/observability/metrics.registry";
import {
  classifyPoolSaturation,
  DatabasePoolMonitorService,
  normalizeHistogramBuckets,
  parsePoolLimit,
  percentileFromBuckets,
  resolveDatabasePoolSettings,
} from "./database-pool-monitor.service";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PASSWORD_URL =
  "postgresql://app:hunter2@db.internal:5432/earnproof?connection_limit=10&pool_timeout=5";

function buildConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const base: Record<string, unknown> = {
    databaseUrl: PASSWORD_URL,
    "databasePool.enabled": true,
    "databasePool.warnUtilization": 0.7,
    "databasePool.criticalUtilization": 0.9,
    "databasePool.warnWaitMs": 100,
    "databasePool.criticalWaitMs": 500,
    "databasePool.sustainSamples": 3,
    "databasePool.clearSamples": 2,
    "databasePool.sampleTimeoutMs": 2_000,
    "databasePool.minSampleIntervalMs": 0,
    "databasePool.maxWaitSamples": 120,
    "databasePool.runbook": "docs/runbooks/database-pool-saturation.md",
  };
  const merged = { ...base, ...overrides };
  return {
    get: jest.fn((key: string) => merged[key]),
  } as unknown as ConfigService;
}

/** Prisma `$metrics.json()` payload: busy 7 of 10, wait p95 in the 100 bucket. */
function metricsPayload(overrides: {
  busy?: number;
  open?: number;
  idle?: number;
  waiting?: number;
  buckets?: Array<[number, number]>;
  sum?: number;
  count?: number;
} = {}) {
  const {
    busy = 7,
    open = 9,
    idle = 2,
    waiting = 1,
    buckets = [
      [10, 6],
      [50, 3],
      [100, 1],
      [500, 0],
    ],
    sum = 600,
    count = 10,
  } = overrides;
  return {
    counters: [{ name: "prisma_client_queries_wait", value: waiting }],
    gauges: [
      { name: "prisma_pool_connections_open", value: open },
      { name: "prisma_pool_connections_busy", value: busy },
      { name: "prisma_pool_connections_idle", value: idle },
    ],
    histograms: [
      {
        name: "prisma_client_queries_wait_histogram_ms",
        buckets,
        sum,
        count,
      },
    ],
  };
}

function buildPrisma(payload: unknown = metricsPayload()) {
  return {
    $metrics: { json: jest.fn().mockResolvedValue(payload) },
  };
}

function findCounter(registry: MetricsRegistry, name: string): CounterSnapshot {
  const metric = registry.snapshot().find((entry) => entry.name === name);
  if (!metric || metric.type !== "counter") {
    throw new Error(`counter ${name} not found`);
  }
  return metric;
}

function findHistogram(registry: MetricsRegistry, name: string): HistogramSnapshot {
  const metric = registry.snapshot().find((entry) => entry.name === name);
  if (!metric || metric.type !== "histogram") {
    throw new Error(`histogram ${name} not found`);
  }
  return metric;
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("parsePoolLimit", () => {
  it("reads connection_limit from the URL", () => {
    expect(parsePoolLimit(PASSWORD_URL, 4)).toBe(10);
  });

  it("falls back to 2 * CPUs + 1 when the parameter is absent", () => {
    expect(
      parsePoolLimit("postgresql://app@db.internal:5432/earnproof", 4),
    ).toBe(9);
  });

  it("falls back on an invalid limit or an unparsable URL", () => {
    expect(parsePoolLimit("postgresql://app@db:5432/e?connection_limit=abc", 4)).toBe(9);
    expect(parsePoolLimit("not a url", 4)).toBe(9);
    expect(parsePoolLimit(undefined, 4)).toBe(9);
  });

  it("clamps the limit to the bounded range", () => {
    expect(parsePoolLimit("postgresql://h/db?connection_limit=0", 4)).toBe(9);
    expect(parsePoolLimit("postgresql://h/db?connection_limit=5000", 4)).toBe(1_000);
  });
});

describe("percentileFromBuckets", () => {
  const buckets: Array<[number, number]> = [
    [10, 5],
    [50, 3],
    [100, 1],
    [500, 1],
  ];

  it("returns the first bucket reaching the quantile", () => {
    expect(percentileFromBuckets(buckets, 0.5)).toBe(10);
    expect(percentileFromBuckets(buckets, 0.95)).toBe(500);
  });

  it("returns null for an empty histogram", () => {
    expect(percentileFromBuckets([], 0.95)).toBeNull();
    expect(
      percentileFromBuckets(
        [
          [10, 0],
          [50, 0],
        ],
        0.95,
      ),
    ).toBeNull();
  });
});

describe("normalizeHistogramBuckets", () => {
  it("accepts tuple buckets", () => {
    expect(
      normalizeHistogramBuckets([
        [50, 3],
        [10, 5],
      ]),
    ).toEqual([
      [10, 5],
      [50, 3],
    ]);
  });

  it("accepts object buckets and map buckets", () => {
    expect(
      normalizeHistogramBuckets([{ le: 10, count: 5 }, { le: 50, count: 3 }]),
    ).toEqual([
      [10, 5],
      [50, 3],
    ]);
    expect(normalizeHistogramBuckets({ "10": 5, "50": 3 })).toEqual([
      [10, 5],
      [50, 3],
    ]);
  });

  it("drops malformed buckets", () => {
    expect(normalizeHistogramBuckets([["x", 1], [10, -1], null])).toEqual([]);
  });
});

describe("classifyPoolSaturation", () => {
  const thresholds = {
    warnUtilization: 0.7,
    criticalUtilization: 0.9,
    warnWaitMs: 100,
    criticalWaitMs: 500,
    sustainSamples: 3,
    clearSamples: 2,
  };

  it("is ok below both warn thresholds", () => {
    expect(classifyPoolSaturation(0.5, 50, thresholds)).toBe("ok");
  });

  it("is warning at exactly the warn threshold (boundary belongs to the worse state)", () => {
    expect(classifyPoolSaturation(0.7, 50, thresholds)).toBe("warning");
    expect(classifyPoolSaturation(0.5, 100, thresholds)).toBe("warning");
  });

  it("is critical at exactly the critical threshold", () => {
    expect(classifyPoolSaturation(0.9, 50, thresholds)).toBe("critical");
    expect(classifyPoolSaturation(0.5, 500, thresholds)).toBe("critical");
  });

  it("is critical on wait alone, and warning on utilization alone", () => {
    expect(classifyPoolSaturation(null, 600, thresholds)).toBe("critical");
    expect(classifyPoolSaturation(0.8, null, thresholds)).toBe("warning");
  });

  it("is unknown when neither signal is observable", () => {
    expect(classifyPoolSaturation(null, null, thresholds)).toBe("unknown");
  });
});

describe("resolveDatabasePoolSettings", () => {
  it("uses configured values", () => {
    const settings = resolveDatabasePoolSettings(buildConfig());
    expect(settings.warnUtilization).toBe(0.7);
    expect(settings.criticalUtilization).toBe(0.9);
    expect(settings.sustainSamples).toBe(3);
  });

  it("clamps out-of-range values and enforces warn below critical", () => {
    const settings = resolveDatabasePoolSettings(
      buildConfig({
        "databasePool.warnUtilization": 0.95,
        "databasePool.criticalUtilization": 0.5,
        "databasePool.warnWaitMs": 900,
        "databasePool.criticalWaitMs": 100,
        "databasePool.sustainSamples": 99,
      }),
    );
    expect(settings.warnUtilization).toBeLessThan(settings.criticalUtilization);
    expect(settings.warnWaitMs).toBeLessThan(settings.criticalWaitMs);
    expect(settings.sustainSamples).toBe(10);
  });

  it("falls back to defaults on non-numeric values", () => {
    const settings = resolveDatabasePoolSettings(
      buildConfig({ "databasePool.warnWaitMs": Number.NaN }),
    );
    expect(settings.warnWaitMs).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Service: sampling and classification
// ---------------------------------------------------------------------------

describe("DatabasePoolMonitorService — sampling", () => {
  it("exposes bounded pool metrics, wait latency, thresholds, and the runbook link", async () => {
    const service = new DatabasePoolMonitorService(buildConfig(), buildPrisma() as never);

    const snapshot = await service.sample(1_000);

    expect(snapshot.status).toBe("warning");
    expect(snapshot.reason).toBe("database_pool_saturation_warning");
    expect(snapshot.pool).toEqual({
      limit: 10,
      open: 9,
      busy: 7,
      idle: 2,
      waiting: 1,
      utilization: 0.7,
    });
    expect(snapshot.wait).toEqual({
      p50Ms: 10,
      p95Ms: 100,
      meanMs: 60,
      samples: 10,
      source: "prisma_histogram",
    });
    expect(snapshot.thresholds).toEqual({
      warnUtilization: 0.7,
      criticalUtilization: 0.9,
      warnWaitMs: 100,
      criticalWaitMs: 500,
      sustainSamples: 3,
      clearSamples: 2,
    });
    expect(snapshot.runbook).toBe("docs/runbooks/database-pool-saturation.md");
    expect(snapshot.alert.blocksReadiness).toBe(false);
    expect(snapshot.sampledAt).toBe(new Date(1_000).toISOString());
  });

  it("never exposes credentials, host, or query text in the snapshot", async () => {
    const service = new DatabasePoolMonitorService(buildConfig(), buildPrisma() as never);
    const snapshot = await service.sample(1_000);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("db.internal");
    expect(serialized).not.toContain("postgresql://");
    expect(serialized).not.toContain("earnproof");
  });

  it("prefers busy over open for utilization, and falls back to open", async () => {
    const busyOnly = new DatabasePoolMonitorService(
      buildConfig(),
      buildPrisma(metricsPayload({ busy: 9, open: 9 })) as never,
    );
    expect((await busyOnly.sample(1_000)).pool.utilization).toBe(0.9);

    const openOnly = new DatabasePoolMonitorService(
      buildConfig(),
      buildPrisma({
        counters: [],
        gauges: [{ name: "prisma_pool_connections_open", value: 4 }],
        histograms: [],
      }) as never,
    );
    expect((await openOnly.sample(1_000)).pool.utilization).toBe(0.4);
  });

  it("returns unknown, never blocking, when metrics are unavailable", async () => {
    const noMetrics = new DatabasePoolMonitorService(
      buildConfig(),
      {} as never,
    );
    const snapshot = await noMetrics.sample(1_000);
    expect(snapshot.status).toBe("unknown");
    expect(snapshot.reason).toBe("database_pool_metrics_unavailable");
    expect(snapshot.pool.utilization).toBeNull();
    expect(noMetrics.blocksReadiness()).toBe(false);

    const failing = new DatabasePoolMonitorService(
      buildConfig(),
      { $metrics: { json: jest.fn().mockRejectedValue(new Error("boom")) } } as never,
    );
    const failed = await failing.sample(1_000);
    expect(failed.status).toBe("unknown");
    expect(failed.reason).toBe("database_pool_metrics_unavailable");
    expect(failing.blocksReadiness()).toBe(false);
  });

  it("reports disabled and never reads metrics when disabled", async () => {
    const prisma = buildPrisma();
    const service = new DatabasePoolMonitorService(
      buildConfig({ "databasePool.enabled": false }),
      prisma as never,
    );
    const snapshot = await service.sample(1_000);
    expect(snapshot.status).toBe("disabled");
    expect(snapshot.reason).toBe("database_pool_monitor_disabled");
    expect(service.blocksReadiness()).toBe(false);
    expect(prisma.$metrics.json).not.toHaveBeenCalled();
  });

  it("is unknown with a stable reason before the first sample", () => {
    const service = new DatabasePoolMonitorService(buildConfig(), buildPrisma() as never);
    const snapshot = service.snapshot(1_000);
    expect(snapshot.status).toBe("unknown");
    expect(snapshot.reason).toBe("database_pool_not_sampled");
    expect(snapshot.sampledAt).toBeNull();
    expect(snapshot.sampleAgeMs).toBeNull();
  });

  it("rate-limits re-reads within the minimum sample interval", async () => {
    const prisma = buildPrisma();
    const service = new DatabasePoolMonitorService(
      buildConfig({ "databasePool.minSampleIntervalMs": 1_000 }),
      prisma as never,
    );
    await service.sample(1_000);
    await service.sample(1_500);
    expect(prisma.$metrics.json).toHaveBeenCalledTimes(1);
    const refreshed = await service.sample(2_000);
    expect(prisma.$metrics.json).toHaveBeenCalledTimes(2);
    expect(refreshed.sampleAgeMs).toBe(0);
  });

  it("shares one in-flight read between concurrent callers", async () => {
    const prisma = buildPrisma();
    const service = new DatabasePoolMonitorService(buildConfig(), prisma as never);
    const [a, b] = await Promise.all([service.sample(1_000), service.sample(1_000)]);
    expect(a).toEqual(b);
    expect(prisma.$metrics.json).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Service: hysteresis (readiness)
// ---------------------------------------------------------------------------

describe("DatabasePoolMonitorService — hysteresis", () => {
  const criticalPayload = () =>
    metricsPayload({
      busy: 10,
      buckets: [
        [10, 0],
        [500, 0],
        [1_000, 10],
      ],
      sum: 9_000,
      count: 10,
    });
  const healthyPayload = () =>
    metricsPayload({
      busy: 2,
      waiting: 0,
      buckets: [
        [10, 10],
        [500, 0],
      ],
      sum: 50,
      count: 10,
    });

  it("does not block readiness on a single critical sample", async () => {
    const service = new DatabasePoolMonitorService(
      buildConfig(),
      buildPrisma(criticalPayload()) as never,
    );
    const snapshot = await service.sample(1_000);
    expect(snapshot.status).toBe("critical");
    expect(snapshot.reason).toBe("database_pool_saturation_critical");
    expect(snapshot.alert.consecutiveSaturated).toBe(1);
    expect(service.blocksReadiness()).toBe(false);
  });

  it("blocks readiness only after the configured sustain count", async () => {
    const prisma = buildPrisma(criticalPayload());
    const service = new DatabasePoolMonitorService(buildConfig(), prisma as never);
    await service.sample(1_000);
    await service.sample(2_000);
    expect(service.blocksReadiness()).toBe(false);
    const third = await service.sample(3_000);
    expect(third.status).toBe("critical");
    expect(third.reason).toBe("database_pool_saturation_sustained");
    expect(third.alert.blocksReadiness).toBe(true);
    expect(service.blocksReadiness()).toBe(true);
  });

  it("clears the latch only after the configured healthy count", async () => {
    const prisma = buildPrisma(criticalPayload());
    const service = new DatabasePoolMonitorService(buildConfig(), prisma as never);
    await service.sample(1_000);
    await service.sample(2_000);
    await service.sample(3_000);
    expect(service.blocksReadiness()).toBe(true);

    prisma.$metrics.json.mockResolvedValue(healthyPayload());
    await service.sample(4_000);
    expect(service.blocksReadiness()).toBe(true);
    const cleared = await service.sample(5_000);
    expect(cleared.status).toBe("ok");
    expect(service.blocksReadiness()).toBe(false);
  });

  it("does not clear the latch on unknown samples", async () => {
    const prisma = buildPrisma(criticalPayload());
    const service = new DatabasePoolMonitorService(buildConfig(), prisma as never);
    await service.sample(1_000);
    await service.sample(2_000);
    await service.sample(3_000);
    expect(service.blocksReadiness()).toBe(true);

    prisma.$metrics.json.mockRejectedValue(new Error("db down"));
    await service.sample(4_000);
    expect(service.blocksReadiness()).toBe(true);
  });

  it("a warning sample neither sustains nor clears the latch", async () => {
    const prisma = buildPrisma(criticalPayload());
    const service = new DatabasePoolMonitorService(buildConfig(), prisma as never);
    await service.sample(1_000);
    await service.sample(2_000);
    prisma.$metrics.json.mockResolvedValue(metricsPayload());
    const warned = await service.sample(3_000);
    expect(warned.status).toBe("warning");
    expect(warned.alert.consecutiveSaturated).toBe(2);
    expect(service.blocksReadiness()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Service: timeouts and fallback wait latency
// ---------------------------------------------------------------------------

describe("DatabasePoolMonitorService — timeouts", () => {
  it("counts a timed-out metrics read and reports it as unknown", async () => {
    const prisma = {
      $metrics: { json: jest.fn(() => new Promise(() => undefined)) },
    } as never;
    const service = new DatabasePoolMonitorService(
      buildConfig({ "databasePool.sampleTimeoutMs": 10 }),
      prisma,
    );
    const snapshot = await service.sample(1_000);
    expect(snapshot.status).toBe("unknown");
    expect(snapshot.reason).toBe("database_pool_sample_timeout");
    expect(snapshot.timeouts).toEqual({ total: 1, consecutive: 1 });
    expect(service.blocksReadiness()).toBe(false);
  });

  it("counts probe timeouts as timeouts and as saturated observations", async () => {
    const service = new DatabasePoolMonitorService(buildConfig(), buildPrisma() as never);
    service.recordProbeOutcome(2_000, true);
    service.recordProbeOutcome(2_000, true);
    expect(service.snapshot(1_000).timeouts).toEqual({ total: 2, consecutive: 2 });
    expect(service.blocksReadiness()).toBe(false);
    service.recordProbeOutcome(2_000, true);
    expect(service.blocksReadiness()).toBe(true);
  });

  it("resets consecutive timeouts on a successful probe", () => {
    const service = new DatabasePoolMonitorService(buildConfig(), buildPrisma() as never);
    service.recordProbeOutcome(2_000, true);
    service.recordProbeOutcome(12, false);
    expect(service.snapshot(1_000).timeouts).toEqual({ total: 1, consecutive: 0 });
  });

  it("bounds the probe-duration fallback buffer", async () => {
    const service = new DatabasePoolMonitorService(
      buildConfig({ "databasePool.maxWaitSamples": 10 }),
      buildPrisma({ counters: [], gauges: [], histograms: [] }) as never,
    );
    for (let i = 0; i < 25; i++) {
      service.recordProbeOutcome(i + 1, false);
    }
    const snapshot = await service.sample(1_000);
    expect(snapshot.wait.source).toBe("probe_duration");
    expect(snapshot.wait.samples).toBe(10);
    expect(snapshot.wait.p50Ms).toBe(21);
  });

  it("does not record probe outcomes when disabled", () => {
    const service = new DatabasePoolMonitorService(
      buildConfig({ "databasePool.enabled": false }),
      buildPrisma() as never,
    );
    service.recordProbeOutcome(2_000, true);
    expect(service.snapshot(1_000).timeouts).toEqual({ total: 0, consecutive: 0 });
  });
});

// ---------------------------------------------------------------------------
// Service: registry observability
// ---------------------------------------------------------------------------

describe("DatabasePoolMonitorService — registry", () => {
  it("emits the timeout counter and wait histogram on the shared registry", async () => {
    const registry = new MetricsRegistry();
    registerCoreMetrics(registry);
    const service = new DatabasePoolMonitorService(
      buildConfig(),
      buildPrisma() as never,
      registry,
    );
    await service.sample(1_000);
    service.recordProbeOutcome(2_000, true);

    const counter = findCounter(registry, METRIC_NAMES.databasePoolTimeoutsTotal);
    expect(counter.series).toHaveLength(1);
    expect(counter.series[0].labels).toEqual({ outcome: "timeout" });
    expect(counter.series[0].value).toBe(1);

    const histogram = findHistogram(registry, METRIC_NAMES.databasePoolWaitDurationMs);
    expect(histogram.series).toHaveLength(1);
    expect(histogram.series[0].labels).toEqual({ pool_status: "warning" });
    expect(histogram.series[0].count).toBe(1);
  });

  it("survives a registry without the catalog registered", async () => {
    const registry = new MetricsRegistry();
    const service = new DatabasePoolMonitorService(
      buildConfig(),
      buildPrisma() as never,
      registry,
    );
    await expect(service.sample(1_000)).resolves.toMatchObject({
      status: "warning",
    });
  });
});

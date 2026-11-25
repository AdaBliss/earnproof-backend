import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { PrismaService } from "../database/prisma.service";
import { DatabasePoolMonitorService } from "./database-pool-monitor.service";
import { DependencyStatus } from "./health.types";
import { HealthService } from "./health.service";

interface ConfigOverrides {
  [key: string]: unknown;
}

function buildConfig(overrides: ConfigOverrides = {}): ConfigService {
  const base: ConfigOverrides = {
    databaseUrl: "postgresql://user:hunter2@db.internal:5432/earnproof?connection_limit=10",
    sessionSecret: "session-secret",
    credentialSigningSecret: "signing-secret",
    "stellar.horizonUrl": "https://horizon-testnet.stellar.org",
    "contractAnchoring.enabled": false,
    "health.probeTimeoutMs": 50,
    "health.cacheTtlMs": 0,
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

function buildPrisma(overrides: Partial<PrismaService> = {}): PrismaService {
  return {
    $queryRaw: jest.fn().mockResolvedValue([{ "?column?": 1 }]),
    webhookDelivery: { count: jest.fn().mockResolvedValue(0) },
    ...overrides,
  } as unknown as PrismaService;
}

function metricsPayload(overrides: {
  busy?: number;
  buckets?: Array<[number, number]>;
  sum?: number;
  count?: number;
} = {}) {
  const {
    busy = 2,
    buckets = [
      [10, 10],
      [500, 0],
    ],
    sum = 50,
    count = 10,
  } = overrides;
  return {
    counters: [{ name: "prisma_client_queries_wait", value: 0 }],
    gauges: [
      { name: "prisma_pool_connections_open", value: busy + 1 },
      { name: "prisma_pool_connections_busy", value: busy },
      { name: "prisma_pool_connections_idle", value: 10 - busy },
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

function buildPoolMonitor(
  config: ConfigService,
  prisma: PrismaService,
): DatabasePoolMonitorService {
  return new DatabasePoolMonitorService(config, prisma);
}

function attachMetrics(prisma: PrismaService, payload: unknown): void {
  (prisma as unknown as Record<string, unknown>).$metrics = {
    json: jest.fn().mockResolvedValue(payload),
  };
}

describe("HealthService — database pool saturation", () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("readiness", () => {
    it("stays ready on a single critical pool sample (hysteresis)", async () => {
      const config = buildConfig();
      const prisma = buildPrisma();
      attachMetrics(prisma, criticalPayload());
      const pool = buildPoolMonitor(config, prisma);
      const service = new HealthService(prisma, config, undefined, undefined, undefined, undefined, pool);

      const result = await service.checkReadiness();

      expect(result.status).toBe("ready");
      expect(result.dependencies.find((d) => d.name === "database_pool")).toBeUndefined();
    });

    it("is not ready with a database_pool dependency after sustained saturation", async () => {
      const config = buildConfig();
      const prisma = buildPrisma();
      attachMetrics(prisma, criticalPayload());
      const pool = buildPoolMonitor(config, prisma);
      const service = new HealthService(prisma, config, undefined, undefined, undefined, undefined, pool);

      await service.checkReadiness();
      await service.checkReadiness();
      const result = await service.checkReadiness();

      expect(result.status).toBe("not_ready");
      const poolDep = result.dependencies.find((d) => d.name === "database_pool");
      expect(poolDep).toBeDefined();
      expect(poolDep?.status).toBe(DependencyStatus.ERROR);
      expect(poolDep?.reason).toBe("database_pool_saturation_sustained");
      expect(poolDep?.kind).toBe("required");
      expect(poolDep?.pool?.status).toBe("critical");
      expect(poolDep?.pool?.thresholds.criticalUtilization).toBe(0.9);
      expect(poolDep?.pool?.runbook).toBe("docs/runbooks/database-pool-saturation.md");
    });

    it("does not sample the pool when the database probe fails", async () => {
      const config = buildConfig();
      const prisma = buildPrisma({
        $queryRaw: jest.fn().mockRejectedValue(new Error("connection refused")),
      });
      const metricsJson = jest.fn().mockResolvedValue(criticalPayload());
      (prisma as unknown as Record<string, unknown>).$metrics = {
        json: metricsJson,
      };
      const pool = buildPoolMonitor(config, prisma);
      const service = new HealthService(prisma, config, undefined, undefined, undefined, undefined, pool);

      const result = await service.checkReadiness();

      expect(result.status).toBe("not_ready");
      expect(result.dependencies.find((d) => d.name === "database")).toBeDefined();
      expect(result.dependencies.find((d) => d.name === "database_pool")).toBeUndefined();
      expect(metricsJson).not.toHaveBeenCalled();
    });

    it("behaves as before when no pool monitor is wired (regression)", async () => {
      const service = new HealthService(buildPrisma(), buildConfig());
      const result = await service.checkReadiness();
      expect(result.status).toBe("ready");
      expect(result.dependencies.find((d) => d.name === "database_pool")).toBeUndefined();
    });
  });

  describe("diagnostics", () => {
    it("exposes the pool snapshot with thresholds and runbook, and no credentials", async () => {
      const config = buildConfig();
      const prisma = buildPrisma();
      attachMetrics(prisma, metricsPayload());
      const pool = buildPoolMonitor(config, prisma);
      const service = new HealthService(prisma, config, undefined, undefined, undefined, undefined, pool);

      const result = await service.checkDiagnostics();

      const poolDep = result.dependencies.find((d) => d.name === "database_pool");
      expect(poolDep).toBeDefined();
      expect(poolDep?.status).toBe(DependencyStatus.OK);
      expect(poolDep?.kind).toBe("optional");
      expect(poolDep?.pool?.pool.limit).toBe(10);
      expect(poolDep?.pool?.pool.utilization).toBe(0.2);
      expect(poolDep?.pool?.wait.source).toBe("prisma_histogram");
      expect(poolDep?.pool?.thresholds).toEqual({
        warnUtilization: 0.7,
        criticalUtilization: 0.9,
        warnWaitMs: 100,
        criticalWaitMs: 500,
        sustainSamples: 3,
        clearSamples: 2,
      });
      expect(JSON.stringify(result)).not.toContain("hunter2");
      expect(JSON.stringify(result)).not.toContain("db.internal");
      expect(JSON.stringify(result)).not.toContain("postgresql://");
    });

    it("reports a warning pool as degraded without blocking the verdict", async () => {
      const config = buildConfig();
      const prisma = buildPrisma();
      attachMetrics(prisma, metricsPayload({ busy: 8 }));
      const pool = buildPoolMonitor(config, prisma);
      const service = new HealthService(prisma, config, undefined, undefined, undefined, undefined, pool);

      const result = await service.checkDiagnostics();

      expect(result.status).toBe("ready");
      const poolDep = result.dependencies.find((d) => d.name === "database_pool");
      expect(poolDep?.status).toBe(DependencyStatus.DEGRADED);
      expect(poolDep?.reason).toBe("database_pool_saturation_warning");
      expect(poolDep?.kind).toBe("optional");
    });

    it("reports not_configured when no pool monitor is wired", async () => {
      const service = new HealthService(buildPrisma(), buildConfig());
      const result = await service.checkDiagnostics();
      const poolDep = result.dependencies.find((d) => d.name === "database_pool");
      expect(poolDep).toBeDefined();
      expect(poolDep?.status).toBe(DependencyStatus.NOT_CONFIGURED);
      expect(poolDep?.reason).toBe("database_pool_monitor_absent");
    });

    it("reports unknown pool state as degraded, never as an error, when metrics are unavailable", async () => {
      const config = buildConfig();
      const prisma = buildPrisma();
      (prisma as unknown as Record<string, unknown>).$metrics = {
        json: jest.fn().mockRejectedValue(new Error("Can't reach database server")),
      };
      const pool = buildPoolMonitor(config, prisma);
      const service = new HealthService(prisma, config, undefined, undefined, undefined, undefined, pool);

      const result = await service.checkDiagnostics();

      const poolDep = result.dependencies.find((d) => d.name === "database_pool");
      expect(poolDep?.status).toBe(DependencyStatus.DEGRADED);
      expect(poolDep?.reason).toBe("database_pool_metrics_unavailable");
      expect(JSON.stringify(result)).not.toContain("Can't reach database server");
      expect(result.status).toBe("ready");
    });
  });

  describe("probe timeouts feed the pool monitor", () => {
    it("counts a timed-out database probe in the pool snapshot", async () => {
      const config = buildConfig({ "health.probeTimeoutMs": 10 });
      const prisma = buildPrisma();
      (prisma as unknown as { $queryRaw: jest.Mock }).$queryRaw = jest.fn(
        () => new Promise(() => undefined),
      );
      attachMetrics(prisma, metricsPayload());
      const pool = buildPoolMonitor(config, prisma);
      const service = new HealthService(prisma, config, undefined, undefined, undefined, undefined, pool);

      const readiness = await service.checkReadiness();
      expect(readiness.dependencies.find((d) => d.name === "database")?.status).toBe(
        DependencyStatus.TIMEOUT,
      );

      const diagnostics = await service.checkDiagnostics();
      const poolDep = diagnostics.dependencies.find((d) => d.name === "database_pool");
      expect(poolDep?.pool?.timeouts.total).toBeGreaterThanOrEqual(1);
    });
  });
});

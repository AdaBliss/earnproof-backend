import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import { DatabasePoolController } from "./database-pool.controller";
import { DatabasePoolMonitorService } from "../health/database-pool-monitor.service";

function makeMonitor(snapshot: unknown) {
  return {
    sample: jest.fn().mockResolvedValue(snapshot),
  } as unknown as DatabasePoolMonitorService;
}

const SNAPSHOT = {
  status: "warning",
  reason: "database_pool_saturation_warning",
  pool: { limit: 10, open: 9, busy: 7, idle: 2, waiting: 1, utilization: 0.7 },
  wait: { p50Ms: 10, p95Ms: 500, meanMs: 60, samples: 10, source: "prisma_histogram" },
  timeouts: { total: 0, consecutive: 0 },
  thresholds: {
    warnUtilization: 0.7,
    criticalUtilization: 0.9,
    warnWaitMs: 100,
    criticalWaitMs: 500,
    sustainSamples: 3,
    clearSamples: 2,
  },
  alert: {
    sustainedCritical: false,
    consecutiveSaturated: 0,
    consecutiveHealthy: 0,
    blocksReadiness: false,
  },
  runbook: "docs/runbooks/database-pool-saturation.md",
  sampledAt: "2026-11-19T00:00:00.000Z",
  sampleAgeMs: 0,
};

describe("DatabasePoolController — positive", () => {
  it("returns the monitor snapshot", async () => {
    const monitor = makeMonitor(SNAPSHOT);
    const controller = new DatabasePoolController(monitor);

    const result = await controller.getPool();

    expect(result).toEqual(SNAPSHOT);
    expect(monitor.sample).toHaveBeenCalledTimes(1);
  });

  it("propagates no credentials or query text", async () => {
    const monitor = makeMonitor(SNAPSHOT);
    const controller = new DatabasePoolController(monitor);
    const result = await controller.getPool();
    expect(JSON.stringify(result)).not.toMatch(/hunter2|postgresql:\/\/|SELECT/i);
  });
});

describe("DatabasePoolController — authorization", () => {
  it("requires session authentication and role enforcement", () => {
    // The risk being guarded against is someone removing a @UseGuards line;
    // decorator metadata is read directly so a mocked guard cannot hide it.
    const guards =
      (Reflect.getMetadata(
        "__guards__",
        DatabasePoolController.prototype.getPool,
      ) as unknown[]) ?? [];
    // Class-level guards are stored on the class itself.
    const classGuards =
      (Reflect.getMetadata("__guards__", DatabasePoolController) as unknown[]) ??
      [];
    const allGuards = [...guards, ...classGuards];
    expect(allGuards).toContain(AuthGuard);
    expect(allGuards).toContain(RoleGuard);
  });

  it("requires the ADMIN role", () => {
    const role =
      Reflect.getMetadata("requiredRole", DatabasePoolController) ??
      Reflect.getMetadata("requiredRole", DatabasePoolController.prototype.getPool);
    expect(role).toBe("ADMIN");
  });
});

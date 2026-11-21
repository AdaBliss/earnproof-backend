import { ConfigService } from "@nestjs/config";
import { METRIC_NAMES, registerCoreMetrics } from "../common/observability/metrics.catalog";
import { MetricsRegistry } from "../common/observability/metrics.registry";
import {
  PressureMeasurement,
  ProcessPressureSource,
} from "../common/observability/process-pressure";
import { ProcessPressureMonitorService } from "./process-pressure-monitor.service";
import { HealthService } from "./health.service";
import { DependencyKind, DependencyStatus } from "./health.types";

class ScriptedSource implements ProcessPressureSource {
  next: PressureMeasurement = { eventLoopDelayMs: 0, heapUsedBytes: 100, heapLimitBytes: 1_000 };
  fail = false;
  disposed = false;
  sample() {
    if (this.fail) throw new Error("native failure with /secret/path");
    return this.next;
  }
  dispose() {
    this.disposed = true;
  }
}

const config = (values: Record<string, unknown> = {}) =>
  ({
    get: (key: string) =>
      ({
        "processPressure.enabled": true,
        "processPressure.degradeAfterSamples": 2,
        "processPressure.recoverAfterSamples": 2,
        ...values,
      })[key],
  }) as unknown as ConfigService;

function build(values: Record<string, unknown> = {}, metrics?: MetricsRegistry) {
  const source = new ScriptedSource();
  const monitor = new ProcessPressureMonitorService(config(values), source, metrics);
  return { monitor, source };
}

describe("ProcessPressureMonitorService", () => {
  it("degrades only after the configured consecutive breaches, using injected measurements", () => {
    const { monitor, source } = build();
    source.next = { eventLoopDelayMs: 800, heapUsedBytes: 100, heapLimitBytes: 1_000 };

    monitor.sample();
    expect(monitor.blocksReadiness()).toBe(false);
    monitor.sample();
    expect(monitor.blocksReadiness()).toBe(true);
  });

  it("recovers with hysteresis", () => {
    const { monitor, source } = build();
    source.next = { eventLoopDelayMs: 800, heapUsedBytes: 100, heapLimitBytes: 1_000 };
    monitor.sample();
    monitor.sample();
    expect(monitor.blocksReadiness()).toBe(true);

    source.next = { eventLoopDelayMs: 10, heapUsedBytes: 100, heapLimitBytes: 1_000 };
    monitor.sample();
    expect(monitor.blocksReadiness()).toBe(true);
    monitor.sample();
    expect(monitor.blocksReadiness()).toBe(false);
  });

  it("never blocks readiness when disabled and takes no measurement", () => {
    const { monitor, source } = build({ "processPressure.enabled": false });
    const spy = jest.spyOn(source, "sample");
    source.next = { eventLoopDelayMs: 9_999, heapUsedBytes: 999, heapLimitBytes: 1_000 };

    monitor.sample();
    monitor.sample();

    expect(spy).not.toHaveBeenCalled();
    expect(monitor.blocksReadiness()).toBe(false);
  });

  it("keeps the last verdict when sampling throws, and never logs the raw error", () => {
    const { monitor, source } = build();
    source.next = { eventLoopDelayMs: 800, heapUsedBytes: 100, heapLimitBytes: 1_000 };
    monitor.sample();
    monitor.sample();
    expect(monitor.blocksReadiness()).toBe(true);

    source.fail = true;
    const warn = jest.spyOn(
      (monitor as unknown as { logger: { warn: () => void } }).logger,
      "warn",
    );
    expect(() => monitor.sample()).not.toThrow();
    expect(monitor.blocksReadiness()).toBe(true);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("/secret/path");
  });

  it("records bounded metrics without labels", () => {
    const registry = new MetricsRegistry();
    registerCoreMetrics(registry);
    const { monitor, source } = build({}, registry);
    source.next = { eventLoopDelayMs: 120, heapUsedBytes: 850, heapLimitBytes: 1_000 };

    monitor.sample();

    const snapshot = registry.snapshot();
    const loop = snapshot.find((s) => s.name === METRIC_NAMES.eventLoopDelayMs);
    const heap = snapshot.find((s) => s.name === METRIC_NAMES.heapUsedPercent);
    expect(loop).toMatchObject({ type: "histogram" });
    expect((loop as { series: Array<{ count: number; sum: number; labels: object }> }).series[0]).toMatchObject({
      count: 1,
      sum: 120,
      labels: {},
    });
    expect((heap as { series: Array<{ sum: number }> }).series[0].sum).toBeCloseTo(85);
  });

  it("starts an unref'd sampler on init and releases the source on destroy", () => {
    jest.useFakeTimers();
    try {
      const { monitor, source } = build({ "processPressure.sampleIntervalMs": 1_000 });
      const sample = jest.spyOn(monitor, "sample");

      monitor.onModuleInit();
      jest.advanceTimersByTime(3_000);
      expect(sample).toHaveBeenCalledTimes(3);

      monitor.onModuleDestroy();
      jest.advanceTimersByTime(3_000);
      expect(sample).toHaveBeenCalledTimes(3);
      expect(source.disposed).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("HealthService process pressure integration", () => {
  const prisma = { $queryRaw: jest.fn().mockResolvedValue([1]) };
  const healthConfig = {
    get: (key: string) => (key === "health.cacheTtlMs" ? 0 : undefined),
  } as unknown as ConfigService;

  function service(monitor?: ProcessPressureMonitorService) {
    return new HealthService(
      prisma as never,
      healthConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      monitor,
    );
  }

  function pressured() {
    const { monitor, source } = build();
    source.next = { eventLoopDelayMs: 900, heapUsedBytes: 950, heapLimitBytes: 1_000 };
    monitor.sample();
    monitor.sample();
    return monitor;
  }

  it("readiness is unaffected while pressure is healthy", async () => {
    const { monitor } = build();
    monitor.sample();
    const result = await service(monitor).checkReadiness();
    const entry = result.dependencies.find((d) => d.name === "process_pressure");
    expect(entry).toMatchObject({ kind: DependencyKind.REQUIRED, status: DependencyStatus.OK });
  });

  it("readiness reports not_ready with only a stable reason code under sustained pressure", async () => {
    const result = await service(pressured()).checkReadiness();

    expect(result.status).toBe("not_ready");
    const entry = result.dependencies.find((d) => d.name === "process_pressure");
    expect(entry).toMatchObject({
      status: DependencyStatus.ERROR,
      reason: "process_pressure_degraded",
    });
  });

  it("public readiness leaks no measurements, thresholds or heap figures", async () => {
    const result = await service(pressured()).checkReadiness();
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("processPressure");
    expect(serialized).not.toMatch(/eventLoopDelayMs|heapUsedRatio|thresholds|heapLimit/);
    expect(serialized).not.toContain("event_loop_lag");
    expect(serialized).not.toContain("heap_pressure");
  });

  it("omits the probe entirely when the monitor is disabled or absent", async () => {
    const disabled = build({ "processPressure.enabled": false }).monitor;
    for (const svc of [service(disabled), service(undefined)]) {
      const result = await svc.checkReadiness();
      expect(result.dependencies.find((d) => d.name === "process_pressure")).toBeUndefined();
    }
  });

  it("diagnostics expose measurements and specific reasons for authorized callers", async () => {
    const result = await service(pressured()).checkDiagnostics();
    const entry = result.dependencies.find((d) => d.name === "process_pressure");

    expect(entry).toMatchObject({
      kind: DependencyKind.REQUIRED,
      status: DependencyStatus.ERROR,
      reason: "process_pressure_degraded:event_loop_lag,heap_pressure",
    });
    expect(entry?.processPressure).toMatchObject({
      state: "degraded",
      thresholds: { eventLoopDegradeMs: 500 },
    });
  });

  it("diagnostics reports not_configured when no monitor is wired", async () => {
    const result = await service(undefined).checkDiagnostics();
    expect(result.dependencies.find((d) => d.name === "process_pressure")).toMatchObject({
      status: DependencyStatus.NOT_CONFIGURED,
    });
  });
});

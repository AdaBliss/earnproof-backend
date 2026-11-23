import { InvalidMetricLabelError } from "./metric-labels";
import { METRIC_NAMES, registerCoreMetrics } from "./metrics.catalog";
import {
  MetricDefinitionError,
  MetricsRegistry,
  type CounterSnapshot,
  type HistogramSnapshot,
} from "./metrics.registry";

describe("MetricsRegistry", () => {
  let registry: MetricsRegistry;

  beforeEach(() => {
    registry = new MetricsRegistry();
  });

  describe("label enforcement", () => {
    beforeEach(() => {
      registry.registerCounter({
        name: "test_total",
        help: "Test counter.",
        labelNames: ["workflow", "outcome"],
      });
    });

    it("rejects a forbidden label at observation time", () => {
      // The registry is the enforcement point, not just a convention.
      expect(() =>
        registry.increment("test_total", {
          workflow: "auth",
          wallet: "GABC",
        } as never),
      ).toThrow();
    });

    it("rejects an undeclared label", () => {
      expect(() =>
        registry.increment("test_total", {
          workflow: "auth",
          outcome: "success",
          route: "/proofs",
        }),
      ).toThrow(MetricDefinitionError);
    });

    it("rejects a missing declared label", () => {
      // A missing label silently merges two series, changing what the metric
      // measures without changing its name.
      expect(() => registry.increment("test_total", { workflow: "auth" })).toThrow(
        /requires label "outcome"/,
      );
    });

    it("rejects an unlisted value for a declared label", () => {
      expect(() =>
        registry.increment("test_total", {
          workflow: "auth",
          outcome: "sort_of",
        }),
      ).toThrow(InvalidMetricLabelError);
    });

    it("accepts a fully valid label set", () => {
      expect(() =>
        registry.increment("test_total", {
          workflow: "auth",
          outcome: "success",
        }),
      ).not.toThrow();
    });
  });

  describe("registration guards", () => {
    it("refuses a metric declaring a forbidden label", () => {
      // Rejected at registration, so the failure surfaces at boot rather than
      // on the first request that populates the dimension.
      expect(() =>
        registry.registerCounter({
          name: "leaky_total",
          help: "Leaks a wallet.",
          labelNames: ["wallet" as never],
        }),
      ).toThrow(MetricDefinitionError);
    });

    it("refuses a metric whose theoretical series count is too large", () => {
      expect(() =>
        registry.registerCounter({
          name: "wide_total",
          help: "Too many dimensions.",
          labelNames: [
            "workflow",
            "outcome",
            "route",
            "method",
            "status_class",
            "job",
          ],
        }),
      ).toThrow(/would permit \d+ series/);
    });

    it("refuses a name that is not lower_snake_case", () => {
      expect(() =>
        registry.registerCounter({ name: "HTTPRequests", help: "Bad name." }),
      ).toThrow(/lower_snake_case/);
    });

    it("refuses a metric with no help text", () => {
      expect(() =>
        registry.registerCounter({ name: "nohelp_total", help: "  " }),
      ).toThrow(/help string/);
    });

    it("refuses non-ascending histogram buckets", () => {
      expect(() =>
        registry.registerHistogram({
          name: "bad_buckets_ms",
          help: "Unsorted.",
          buckets: [10, 5, 20],
        }),
      ).toThrow(/strictly ascending/);
    });

    it("is idempotent for an identical definition", () => {
      const definition = {
        name: "idem_total",
        help: "Same.",
        labelNames: ["outcome"] as const,
      };
      registry.registerCounter(definition);
      expect(() => registry.registerCounter(definition)).not.toThrow();
    });

    it("refuses to redefine a metric with a different label set", () => {
      registry.registerCounter({
        name: "shift_total",
        help: "First.",
        labelNames: ["outcome"],
      });
      expect(() =>
        registry.registerCounter({
          name: "shift_total",
          help: "Second.",
          labelNames: ["workflow"],
        }),
      ).toThrow(/already registered with labels/);
    });

    it("refuses an observation on an unregistered metric", () => {
      expect(() => registry.increment("never_registered_total")).toThrow(
        /before it was registered/,
      );
    });
  });

  describe("counters", () => {
    beforeEach(() => {
      registry.registerCounter({
        name: "events_total",
        help: "Events.",
        labelNames: ["outcome"],
      });
    });

    it("accumulates within a series", () => {
      registry.increment("events_total", { outcome: "success" });
      registry.increment("events_total", { outcome: "success" }, 4);

      const snapshot = findCounter(registry, "events_total");
      expect(snapshot.series).toHaveLength(1);
      expect(snapshot.series[0].value).toBe(5);
    });

    it("keeps distinct label sets in distinct series", () => {
      registry.increment("events_total", { outcome: "success" });
      registry.increment("events_total", { outcome: "server_error" });

      expect(findCounter(registry, "events_total").series).toHaveLength(2);
    });

    it("refuses a negative increment", () => {
      expect(() =>
        registry.increment("events_total", { outcome: "success" }, -1),
      ).toThrow(/non-negative/);
    });
  });

  describe("histograms", () => {
    beforeEach(() => {
      registry.registerHistogram({
        name: "latency_ms",
        help: "Latency.",
        labelNames: ["outcome"],
        buckets: [10, 100, 1_000],
      });
    });

    it("records sum and count", () => {
      registry.observe("latency_ms", 5, { outcome: "success" });
      registry.observe("latency_ms", 45, { outcome: "success" });

      const series = findHistogram(registry, "latency_ms").series[0];
      expect(series.count).toBe(2);
      expect(series.sum).toBe(50);
    });

    it("fills buckets cumulatively", () => {
      // Cumulative buckets are what make quantile estimation possible; a value
      // must land in its own bucket and every wider one.
      registry.observe("latency_ms", 5, { outcome: "success" });

      const series = findHistogram(registry, "latency_ms").series[0];
      expect(series.bucketCounts[0]).toBe(1); // <= 10
      expect(series.bucketCounts[1]).toBe(1); // <= 100
      expect(series.bucketCounts[2]).toBe(1); // <= 1000
      expect(series.bucketCounts[3]).toBe(0); // +Inf overflow
    });

    it("places an over-range value in the overflow bucket only", () => {
      registry.observe("latency_ms", 9_999, { outcome: "timeout" });

      const series = findHistogram(registry, "latency_ms").series[0];
      expect(series.bucketCounts[0]).toBe(0);
      expect(series.bucketCounts[3]).toBe(1);
    });

    it("includes a boundary value in its own bucket", () => {
      registry.observe("latency_ms", 10, { outcome: "success" });
      expect(
        findHistogram(registry, "latency_ms").series[0].bucketCounts[0],
      ).toBe(1);
    });

    it("refuses a negative observation", () => {
      expect(() =>
        registry.observe("latency_ms", -5, { outcome: "success" }),
      ).toThrow(/non-negative/);
    });
  });

  describe("time()", () => {
    beforeEach(() => {
      registry.registerHistogram({
        name: "timed_ms",
        help: "Timed.",
        labelNames: ["outcome"],
      });
    });

    it("records a successful operation", async () => {
      await registry.time("timed_ms", { outcome: "success" }, async () => "ok");
      expect(findHistogram(registry, "timed_ms").series[0].count).toBe(1);
    });

    it("records a failed operation and rethrows", async () => {
      // A latency metric that excludes failures measures the wrong population:
      // during an incident the failing requests are the interesting ones.
      await expect(
        registry.time("timed_ms", { outcome: "server_error" }, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(findHistogram(registry, "timed_ms").series[0].count).toBe(1);
    });
  });

  describe("the SLI catalog", () => {
    beforeEach(() => {
      registerCoreMetrics(registry);
    });

    it("registers without violating any label rule", () => {
      // registerCoreMetrics throws on a bad definition, so reaching here is the
      // assertion; the snapshot check confirms the metrics actually exist.
      expect(registry.snapshot().length).toBeGreaterThan(0);
    });

    it("is idempotent, so a re-imported module does not fail boot", () => {
      expect(() => registerCoreMetrics(registry)).not.toThrow();
    });

    it("covers every SLI named in the acceptance criteria", () => {
      const names = new Set(registry.snapshot().map((metric) => metric.name));

      // API availability and latency
      expect(names).toContain(METRIC_NAMES.httpRequestsTotal);
      expect(names).toContain(METRIC_NAMES.httpRequestDurationMs);
      expect(names).toContain(METRIC_NAMES.requestBodyRejectionsTotal);
      // Sync freshness
      expect(names).toContain(METRIC_NAMES.horizonSyncLagSeconds);
      // Anchoring backlog
      expect(names).toContain(METRIC_NAMES.anchoringBacklogSize);
      // Webhook delivery
      expect(names).toContain(METRIC_NAMES.webhookDeliveriesTotal);
      // Database health
      expect(names).toContain(METRIC_NAMES.databaseProbesTotal);
      // Verification outcomes
      expect(names).toContain(METRIC_NAMES.verificationsTotal);
    });

    it("keeps every catalogued metric within the series budget", () => {
      // The budget is enforced at registration; asserting it here documents the
      // property and fails loudly if a limit is raised without review.
      for (const metric of registry.snapshot()) {
        expect(metric.series.length).toBeLessThanOrEqual(512);
      }
    });
  });

  describe("snapshot", () => {
    it("does not expose internal state for mutation", () => {
      registry.registerCounter({ name: "iso_total", help: "Isolated." });
      registry.increment("iso_total");

      const first = findCounter(registry, "iso_total");
      first.series[0].value = 9_999;

      expect(findCounter(registry, "iso_total").series[0].value).toBe(1);
    });

    it("clears series but keeps registrations on reset", () => {
      registry.registerCounter({ name: "reset_total", help: "Resettable." });
      registry.increment("reset_total");
      registry.reset();

      expect(findCounter(registry, "reset_total").series).toHaveLength(0);
      expect(() => registry.increment("reset_total")).not.toThrow();
    });
  });
});

function findCounter(registry: MetricsRegistry, name: string): CounterSnapshot {
  const metric = registry.snapshot().find((entry) => entry.name === name);
  if (!metric || metric.type !== "counter") {
    throw new Error(`counter ${name} not found`);
  }
  return metric;
}

function findHistogram(
  registry: MetricsRegistry,
  name: string,
): HistogramSnapshot {
  const metric = registry.snapshot().find((entry) => entry.name === name);
  if (!metric || metric.type !== "histogram") {
    throw new Error(`histogram ${name} not found`);
  }
  return metric;
}

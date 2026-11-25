import {
  NodeProcessPressureSource,
  PROCESS_PRESSURE_DEFAULTS,
  PressureMeasurement,
  ProcessPressureEvaluator,
  normalizeProcessPressureSettings,
} from "./process-pressure";

const LIMIT = 1_000;
const m = (eventLoopDelayMs: number, heapPct = 10): PressureMeasurement => ({
  eventLoopDelayMs,
  heapUsedBytes: (heapPct / 100) * LIMIT,
  heapLimitBytes: LIMIT,
});

// degrade: loop>=500ms or heap>=90%, after 3 breaches.
// recover: loop<200ms and heap<80%, after 6 clears.
function evaluator(overrides = {}) {
  return new ProcessPressureEvaluator(
    normalizeProcessPressureSettings({ ...PROCESS_PRESSURE_DEFAULTS, ...overrides }),
  );
}

describe("normalizeProcessPressureSettings", () => {
  it("uses the defaults when nothing is configured", () => {
    expect(normalizeProcessPressureSettings({})).toEqual(PROCESS_PRESSURE_DEFAULTS);
  });

  it("clamps every value into its bound", () => {
    const s = normalizeProcessPressureSettings({
      sampleIntervalMs: 1,
      eventLoopDegradeMs: 9_999_999,
      eventLoopRecoverMs: 1,
      heapDegradeRatio: 5,
      heapRecoverRatio: -1,
      degradeAfterSamples: 0,
      recoverAfterSamples: 10_000,
    });
    expect(s.sampleIntervalMs).toBe(500);
    expect(s.eventLoopDegradeMs).toBe(60_000);
    expect(s.eventLoopRecoverMs).toBe(10);
    expect(s.heapDegradeRatio).toBe(0.99);
    expect(s.heapRecoverRatio).toBe(0.5);
    expect(s.degradeAfterSamples).toBe(1);
    expect(s.recoverAfterSamples).toBe(120);
  });

  it("forces recover strictly below degrade so a hysteresis band always exists", () => {
    const s = normalizeProcessPressureSettings({
      eventLoopDegradeMs: 300,
      eventLoopRecoverMs: 900,
      heapDegradeRatio: 0.8,
      heapRecoverRatio: 0.95,
    });
    expect(s.eventLoopRecoverMs).toBeLessThan(s.eventLoopDegradeMs);
    expect(s.heapRecoverRatio).toBeLessThan(s.heapDegradeRatio);
  });

  it.each([NaN, undefined, "junk", Infinity])("falls back to defaults for %p", (value) => {
    const s = normalizeProcessPressureSettings({
      sampleIntervalMs: value,
      heapDegradeRatio: value,
    });
    expect(s.sampleIntervalMs).toBe(PROCESS_PRESSURE_DEFAULTS.sampleIntervalMs);
    expect(s.heapDegradeRatio).toBe(PROCESS_PRESSURE_DEFAULTS.heapDegradeRatio);
  });

  it("treats only an explicit true as enabled", () => {
    expect(normalizeProcessPressureSettings({ enabled: "true" }).enabled).toBe(false);
    expect(normalizeProcessPressureSettings({ enabled: true }).enabled).toBe(true);
    expect(normalizeProcessPressureSettings({}).enabled).toBe(true);
  });
});

describe("ProcessPressureEvaluator", () => {
  it("starts ok with no samples", () => {
    const e = evaluator();
    expect(e.isDegraded).toBe(false);
    expect(e.snapshot()).toMatchObject({ state: "ok", samples: 0, eventLoopDelayMs: null });
  });

  it("stays ok below the thresholds", () => {
    const e = evaluator();
    for (let i = 0; i < 20; i += 1) e.record(m(50, 40));
    expect(e.isDegraded).toBe(false);
  });

  it("does not degrade before the configured number of consecutive breaches", () => {
    const e = evaluator();
    e.record(m(900));
    e.record(m(900));
    expect(e.isDegraded).toBe(false);
    e.record(m(900));
    expect(e.isDegraded).toBe(true);
  });

  it("degrades at exactly the threshold, not just below it (boundary)", () => {
    const below = evaluator({ degradeAfterSamples: 1 });
    below.record(m(499.9));
    expect(below.isDegraded).toBe(false);

    const at = evaluator({ degradeAfterSamples: 1 });
    at.record(m(500));
    expect(at.isDegraded).toBe(true);
  });

  it("a single slow sample amid healthy ones never degrades (burst tolerance)", () => {
    const e = evaluator();
    for (let i = 0; i < 30; i += 1) {
      e.record(i % 2 === 0 ? m(5_000) : m(10));
    }
    expect(e.isDegraded).toBe(false);
  });

  it("degrades on heap pressure alone and names the reason", () => {
    const e = evaluator({ degradeAfterSamples: 1 });
    const snap = e.record(m(10, 95));
    expect(snap.state).toBe("degraded");
    expect(snap.reasons).toEqual(["heap_pressure"]);
  });

  it("names both reasons when both signals are elevated", () => {
    const e = evaluator({ degradeAfterSamples: 1 });
    expect(e.record(m(900, 95)).reasons).toEqual(["event_loop_lag", "heap_pressure"]);
  });

  describe("hysteresis", () => {
    const degraded = () => {
      const e = evaluator({ degradeAfterSamples: 1, recoverAfterSamples: 3 });
      e.record(m(900));
      expect(e.isDegraded).toBe(true);
      return e;
    };

    it("does not recover inside the band between recover and degrade", () => {
      const e = degraded();
      // 300ms is below degrade (500) but above recover (200): not clear.
      for (let i = 0; i < 50; i += 1) e.record(m(300));
      expect(e.isDegraded).toBe(true);
    });

    it("recovers only after the configured number of consecutive clear samples", () => {
      const e = degraded();
      e.record(m(50));
      e.record(m(50));
      expect(e.isDegraded).toBe(true);
      e.record(m(50));
      expect(e.isDegraded).toBe(false);
    });

    it("a non-clear sample restarts the recovery count", () => {
      const e = degraded();
      e.record(m(50));
      e.record(m(50));
      e.record(m(300)); // in the band: resets
      e.record(m(50));
      e.record(m(50));
      expect(e.isDegraded).toBe(true);
      e.record(m(50));
      expect(e.isDegraded).toBe(false);
    });

    it("requires BOTH signals clear to recover", () => {
      const e = degraded();
      for (let i = 0; i < 10; i += 1) e.record(m(50, 85)); // heap in band
      expect(e.isDegraded).toBe(true);
    });

    it("does not flap when a signal oscillates around the degrade threshold", () => {
      const e = evaluator({ degradeAfterSamples: 2, recoverAfterSamples: 4 });
      const transitions: boolean[] = [];
      let previous = e.isDegraded;
      // Alternating 520 / 480 around the 500ms degrade line.
      for (let i = 0; i < 40; i += 1) {
        e.record(m(i % 2 === 0 ? 520 : 480));
        if (e.isDegraded !== previous) {
          transitions.push(e.isDegraded);
          previous = e.isDegraded;
        }
      }
      // 480 is in the band (not < recover 200), so it neither clears nor
      // counts as a fresh breach streak beyond the first: at most one flip.
      expect(transitions.length).toBeLessThanOrEqual(1);
    });

    it("reports which signals are still elevated while degraded", () => {
      const e = evaluator({ degradeAfterSamples: 1, recoverAfterSamples: 5 });
      e.record(m(900, 95));
      expect(e.record(m(50, 95)).reasons).toEqual(["heap_pressure"]);
      expect(e.record(m(300, 10)).reasons).toEqual(["event_loop_lag"]);
    });

    it("clears reasons once recovered", () => {
      const e = degraded();
      for (let i = 0; i < 3; i += 1) e.record(m(10));
      expect(e.snapshot()).toMatchObject({ state: "ok", reasons: [] });
    });
  });

  it("treats a zero heap limit as no heap pressure instead of dividing by zero", () => {
    const e = evaluator({ degradeAfterSamples: 1 });
    e.record({ eventLoopDelayMs: 0, heapUsedBytes: 5, heapLimitBytes: 0 });
    expect(e.isDegraded).toBe(false);
  });

  it("clamps a negative delay to zero", () => {
    const e = evaluator();
    expect(e.record(m(-5)).eventLoopDelayMs).toBe(0);
  });
});

describe("NodeProcessPressureSource", () => {
  it("returns finite, plausible measurements from the real process", () => {
    const source = new NodeProcessPressureSource();
    try {
      const sample = source.sample();
      expect(Number.isFinite(sample.eventLoopDelayMs)).toBe(true);
      expect(sample.eventLoopDelayMs).toBeGreaterThanOrEqual(0);
      expect(sample.heapUsedBytes).toBeGreaterThan(0);
      expect(sample.heapLimitBytes).toBeGreaterThanOrEqual(sample.heapUsedBytes);
    } finally {
      source.dispose();
    }
  });
});

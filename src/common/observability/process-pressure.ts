import { monitorEventLoopDelay } from "perf_hooks";
import { getHeapStatistics } from "v8";

/**
 * Process pressure: bounded event-loop and heap signals with hysteresis.
 *
 * A process can be alive (liveness passes) and still unable to serve safely: a
 * saturated event loop answers late, and a heap near its limit is one allocation
 * from an out-of-memory kill. Readiness is how an orchestrator learns to stop
 * routing traffic to such a replica, so these signals feed it.
 *
 * This file is deliberately free of timers and Nest wiring: the evaluator is a
 * pure state machine driven by injected measurements, so every threshold and
 * every hysteresis transition is testable deterministically.
 */

export interface PressureMeasurement {
  /** p99 event-loop delay over the sampling window, in milliseconds. */
  eventLoopDelayMs: number;
  heapUsedBytes: number;
  /** V8 heap size limit in bytes. */
  heapLimitBytes: number;
}

/** Supplies measurements. Injected so tests never depend on real load. */
export interface ProcessPressureSource {
  sample(): PressureMeasurement;
  /** Releases native resources. */
  dispose?(): void;
}

export interface ProcessPressureSettings {
  enabled: boolean;
  sampleIntervalMs: number;
  /** Event-loop p99 at or above this counts as a breaching sample. */
  eventLoopDegradeMs: number;
  /** Event-loop p99 must fall BELOW this to count as a clear sample. */
  eventLoopRecoverMs: number;
  /** Heap used / heap limit at or above this counts as a breaching sample. */
  heapDegradeRatio: number;
  /** Heap ratio must fall BELOW this to count as a clear sample. */
  heapRecoverRatio: number;
  /** Consecutive breaching samples required before readiness degrades. */
  degradeAfterSamples: number;
  /** Consecutive clear samples required before readiness recovers. */
  recoverAfterSamples: number;
}

export type PressureState = "ok" | "degraded";
export type PressureReason = "event_loop_lag" | "heap_pressure";

export const PROCESS_PRESSURE_DEFAULTS: ProcessPressureSettings = {
  enabled: true,
  sampleIntervalMs: 5_000,
  eventLoopDegradeMs: 500,
  eventLoopRecoverMs: 200,
  heapDegradeRatio: 0.9,
  heapRecoverRatio: 0.8,
  degradeAfterSamples: 3,
  recoverAfterSamples: 6,
};

/** Hard bounds applied to every configured value. */
export const PROCESS_PRESSURE_BOUNDS = {
  sampleIntervalMs: { min: 500, max: 60_000 },
  eventLoopMs: { min: 10, max: 60_000 },
  heapRatio: { min: 0.5, max: 0.99 },
  samples: { min: 1, max: 120 },
} as const;

function clampNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const numeric = typeof value === "number" ? value : Number(value);
  const chosen = Number.isFinite(numeric) ? numeric : fallback;
  return Math.min(max, Math.max(min, chosen));
}

/**
 * Builds safe settings from raw configuration.
 *
 * Every value is clamped into its bound, and each recover threshold is forced
 * strictly below its degrade threshold. Without that gap there is no hysteresis
 * band, and a signal hovering at the threshold would flap readiness on every
 * sample.
 */
export function normalizeProcessPressureSettings(
  raw: Partial<Record<keyof ProcessPressureSettings, unknown>> = {},
): ProcessPressureSettings {
  const d = PROCESS_PRESSURE_DEFAULTS;
  const b = PROCESS_PRESSURE_BOUNDS;

  const eventLoopDegradeMs = clampNumber(
    raw.eventLoopDegradeMs,
    d.eventLoopDegradeMs,
    b.eventLoopMs.min,
    b.eventLoopMs.max,
  );
  const eventLoopRecoverMs = Math.min(
    clampNumber(
      raw.eventLoopRecoverMs,
      d.eventLoopRecoverMs,
      b.eventLoopMs.min,
      b.eventLoopMs.max,
    ),
    // Strictly below the degrade threshold; never below the floor.
    Math.max(b.eventLoopMs.min, eventLoopDegradeMs * 0.9),
  );

  const heapDegradeRatio = clampNumber(
    raw.heapDegradeRatio,
    d.heapDegradeRatio,
    b.heapRatio.min,
    b.heapRatio.max,
  );
  const heapRecoverRatio = Math.min(
    clampNumber(
      raw.heapRecoverRatio,
      d.heapRecoverRatio,
      b.heapRatio.min,
      b.heapRatio.max,
    ),
    Math.max(b.heapRatio.min, heapDegradeRatio - 0.01),
  );

  return {
    enabled: raw.enabled === undefined ? d.enabled : raw.enabled === true,
    sampleIntervalMs: Math.floor(
      clampNumber(
        raw.sampleIntervalMs,
        d.sampleIntervalMs,
        b.sampleIntervalMs.min,
        b.sampleIntervalMs.max,
      ),
    ),
    eventLoopDegradeMs,
    eventLoopRecoverMs,
    heapDegradeRatio,
    heapRecoverRatio,
    degradeAfterSamples: Math.floor(
      clampNumber(
        raw.degradeAfterSamples,
        d.degradeAfterSamples,
        b.samples.min,
        b.samples.max,
      ),
    ),
    recoverAfterSamples: Math.floor(
      clampNumber(
        raw.recoverAfterSamples,
        d.recoverAfterSamples,
        b.samples.min,
        b.samples.max,
      ),
    ),
  };
}

export interface ProcessPressureSnapshot {
  state: PressureState;
  /** Signals currently at or above their recover threshold while degraded. */
  reasons: PressureReason[];
  eventLoopDelayMs: number | null;
  heapUsedRatio: number | null;
  consecutiveBreaches: number;
  consecutiveClears: number;
  samples: number;
}

/**
 * The hysteresis state machine.
 *
 * - `ok` -> `degraded` only after `degradeAfterSamples` CONSECUTIVE breaching
 *   samples. One slow GC pause or one burst never degrades readiness.
 * - `degraded` -> `ok` only after `recoverAfterSamples` CONSECUTIVE samples that
 *   are all below the (lower) recover thresholds. A sample inside the band
 *   between recover and degrade keeps the current state and restarts the count,
 *   which is what stops rapid flapping.
 */
export class ProcessPressureEvaluator {
  private state: PressureState = "ok";
  private reasons: PressureReason[] = [];
  private breaches = 0;
  private clears = 0;
  private samples = 0;
  private last: { eventLoopDelayMs: number; heapUsedRatio: number } | null = null;

  constructor(private readonly settings: ProcessPressureSettings) {}

  record(measurement: PressureMeasurement): ProcessPressureSnapshot {
    const s = this.settings;
    const heapRatio =
      measurement.heapLimitBytes > 0
        ? measurement.heapUsedBytes / measurement.heapLimitBytes
        : 0;
    const loopMs = Math.max(0, measurement.eventLoopDelayMs);
    this.samples += 1;
    this.last = { eventLoopDelayMs: loopMs, heapUsedRatio: heapRatio };

    const loopBreach = loopMs >= s.eventLoopDegradeMs;
    const heapBreach = heapRatio >= s.heapDegradeRatio;
    const loopClear = loopMs < s.eventLoopRecoverMs;
    const heapClear = heapRatio < s.heapRecoverRatio;

    if (this.state === "ok") {
      this.clears = 0;
      this.breaches = loopBreach || heapBreach ? this.breaches + 1 : 0;
      if (this.breaches >= s.degradeAfterSamples) {
        this.state = "degraded";
        this.breaches = 0;
      }
    } else {
      this.breaches = 0;
      this.clears = loopClear && heapClear ? this.clears + 1 : 0;
      if (this.clears >= s.recoverAfterSamples) {
        this.state = "ok";
        this.clears = 0;
      }
    }

    this.reasons =
      this.state === "degraded"
        ? [
            ...(loopClear ? [] : (["event_loop_lag"] as const)),
            ...(heapClear ? [] : (["heap_pressure"] as const)),
          ]
        : [];

    return this.snapshot();
  }

  get isDegraded(): boolean {
    return this.state === "degraded";
  }

  snapshot(): ProcessPressureSnapshot {
    return {
      state: this.state,
      reasons: [...this.reasons],
      eventLoopDelayMs: this.last ? round(this.last.eventLoopDelayMs, 1) : null,
      heapUsedRatio: this.last ? round(this.last.heapUsedRatio, 4) : null,
      consecutiveBreaches: this.breaches,
      consecutiveClears: this.clears,
      samples: this.samples,
    };
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Real measurements from the running process.
 *
 * `monitorEventLoopDelay` is a native, sampling histogram with negligible
 * overhead, and the heap figure is a single synchronous V8 call, so production
 * cost is a handful of microseconds per sample.
 */
export class NodeProcessPressureSource implements ProcessPressureSource {
  private readonly histogram = monitorEventLoopDelay({ resolution: 20 });

  constructor() {
    this.histogram.enable();
  }

  sample(): PressureMeasurement {
    // The histogram reports nanoseconds. A window with no samples reports NaN
    // for percentiles; treat that as no measurable delay.
    const p99Ns = this.histogram.percentile(99);
    this.histogram.reset();
    const heap = getHeapStatistics();
    return {
      eventLoopDelayMs: Number.isFinite(p99Ns) ? p99Ns / 1e6 : 0,
      heapUsedBytes: heap.used_heap_size,
      heapLimitBytes: heap.heap_size_limit,
    };
  }

  dispose(): void {
    this.histogram.disable();
  }
}

import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { METRIC_NAMES } from "../common/observability/metrics.catalog";
import { MetricsRegistry } from "../common/observability/metrics.registry";
import {
  NodeProcessPressureSource,
  ProcessPressureEvaluator,
  ProcessPressureSettings,
  ProcessPressureSnapshot,
  ProcessPressureSource,
  normalizeProcessPressureSettings,
} from "../common/observability/process-pressure";

/** Injection token for a replacement measurement source (tests). */
export const PROCESS_PRESSURE_SOURCE = Symbol("PROCESS_PRESSURE_SOURCE");

/**
 * Samples event-loop delay and heap usage on a fixed interval and tracks a
 * hysteresis-damped degraded/ok verdict for readiness.
 *
 * The monitor only measures and classifies. It never sheds load, restarts the
 * process, or triggers GC; it reports so the orchestrator can stop routing here.
 *
 * Numbers (delay, ratios, thresholds) are exposed only through {@link snapshot},
 * which feeds the authorized diagnostics view. The public readiness probe gets a
 * boolean via {@link blocksReadiness}, so process internals are never public.
 */
@Injectable()
export class ProcessPressureMonitorService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ProcessPressureMonitorService.name);
  private readonly settings: ProcessPressureSettings;
  private readonly evaluator: ProcessPressureEvaluator;
  private source?: ProcessPressureSource;
  private timer?: NodeJS.Timeout;

  constructor(
    config: ConfigService,
    @Optional()
    @Inject(PROCESS_PRESSURE_SOURCE)
    source?: ProcessPressureSource,
    @Optional() private readonly metrics?: MetricsRegistry,
  ) {
    this.settings = normalizeProcessPressureSettings({
      enabled: config.get("processPressure.enabled"),
      sampleIntervalMs: config.get("processPressure.sampleIntervalMs"),
      eventLoopDegradeMs: config.get("processPressure.eventLoopDegradeMs"),
      eventLoopRecoverMs: config.get("processPressure.eventLoopRecoverMs"),
      heapDegradeRatio: config.get("processPressure.heapDegradeRatio"),
      heapRecoverRatio: config.get("processPressure.heapRecoverRatio"),
      degradeAfterSamples: config.get("processPressure.degradeAfterSamples"),
      recoverAfterSamples: config.get("processPressure.recoverAfterSamples"),
    });
    this.evaluator = new ProcessPressureEvaluator(this.settings);
    this.source = source;
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  onModuleInit(): void {
    if (!this.settings.enabled) return;
    this.source ??= new NodeProcessPressureSource();
    this.timer = setInterval(() => this.sample(), this.settings.sampleIntervalMs);
    // The sampler must never keep the process alive on its own.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.source?.dispose?.();
  }

  /**
   * Takes one measurement and advances the state machine. Public so tests drive
   * it with injected measurements instead of waiting on timers.
   */
  sample(): ProcessPressureSnapshot {
    if (!this.settings.enabled || !this.source) return this.evaluator.snapshot();

    const before = this.evaluator.isDegraded;
    let snapshot: ProcessPressureSnapshot;
    try {
      const measurement = this.source.sample();
      snapshot = this.evaluator.record(measurement);
      this.observeMetrics(measurement.eventLoopDelayMs, snapshot);
    } catch (error) {
      // A failed measurement says nothing about pressure; keep the last verdict
      // rather than flipping readiness on a monitoring fault.
      this.logger.warn(
        `Process pressure sampling failed: ${error instanceof Error ? error.name : "unknown"}`,
      );
      return this.evaluator.snapshot();
    }

    if (snapshot.state === "degraded" && !before) {
      this.logger.warn(
        `Process pressure degraded: reasons=${snapshot.reasons.join(",")}`,
      );
    } else if (snapshot.state === "ok" && before) {
      this.logger.log("Process pressure recovered");
    }
    return snapshot;
  }

  /** True when readiness must fail: pressure stayed past threshold. */
  blocksReadiness(): boolean {
    return this.settings.enabled && this.evaluator.isDegraded;
  }

  snapshot(): ProcessPressureSnapshot & {
    thresholds: Pick<
      ProcessPressureSettings,
      | "eventLoopDegradeMs"
      | "eventLoopRecoverMs"
      | "heapDegradeRatio"
      | "heapRecoverRatio"
      | "degradeAfterSamples"
      | "recoverAfterSamples"
    >;
  } {
    const s = this.settings;
    return {
      ...this.evaluator.snapshot(),
      thresholds: {
        eventLoopDegradeMs: s.eventLoopDegradeMs,
        eventLoopRecoverMs: s.eventLoopRecoverMs,
        heapDegradeRatio: s.heapDegradeRatio,
        heapRecoverRatio: s.heapRecoverRatio,
        degradeAfterSamples: s.degradeAfterSamples,
        recoverAfterSamples: s.recoverAfterSamples,
      },
    };
  }

  private observeMetrics(
    eventLoopDelayMs: number,
    snapshot: ProcessPressureSnapshot,
  ): void {
    if (!this.metrics) return;
    this.metrics.observe(METRIC_NAMES.eventLoopDelayMs, Math.max(0, eventLoopDelayMs));
    // Recorded as a percentage so the histogram's non-negative, finite contract
    // and bucket boundaries stay readable (ratio 0.87 -> 87).
    this.metrics.observe(
      METRIC_NAMES.heapUsedPercent,
      Math.max(0, (snapshot.heapUsedRatio ?? 0) * 100),
    );
  }
}

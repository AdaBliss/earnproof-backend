import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { HealthModule } from "../health/health.module";
import { Clock, SystemClock } from "../common/time/clock";
import { MetricRollupService } from "./metric-rollup.service";
import { MetricRollupStore, PrismaMetricRollupStore } from "./metric-rollup.store";
import { MetricsRollupController } from "./metrics-rollup.controller";
import { DatabasePoolController } from "./database-pool.controller";

/**
 * Downsampled operational metrics (#330). `MetricsRegistry` comes from the
 * global ObservabilityModule and `PrismaService` from the global
 * DatabaseModule; scheduling lives in `jobs/metrics-rollup.job.ts`.
 *
 * The pool saturation endpoint reuses `DatabasePoolMonitorService` from
 * `HealthModule` so readiness, diagnostics, and this endpoint can never
 * disagree about pool state (one monitor instance, one hysteresis latch).
 */
@Module({
  imports: [AuthModule, HealthModule],
  controllers: [MetricsRollupController, DatabasePoolController],
  providers: [
    MetricRollupService,
    { provide: MetricRollupStore, useClass: PrismaMetricRollupStore },
    { provide: Clock, useClass: SystemClock },
  ],
  exports: [MetricRollupService],
})
export class MetricsModule {}

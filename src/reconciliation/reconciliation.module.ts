import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { ConfigModule } from "@nestjs/config";
import { DatabaseModule } from "../database/database.module";
import { ContractDigestClient } from "./contract-digest-client";
import { BackendStateDigestCalculator } from "./backend-state-digest-calculator";
import { ContractStateReconciliationService } from "./contract-state-reconciliation.service";
import { ContractReconciliationController } from "./contract-reconciliation.controller";

/**
 * ReconciliationModule
 *
 * Exports services and controllers for contract state reconciliation.
 * Compares backend projections against live contract digests to detect drift.
 */
@Module({
  imports: [ScheduleModule.forRoot(), ConfigModule, DatabaseModule],
  providers: [
    ContractDigestClient,
    BackendStateDigestCalculator,
    ContractStateReconciliationService,
  ],
  controllers: [ContractReconciliationController],
  exports: [
    ContractDigestClient,
    BackendStateDigestCalculator,
    ContractStateReconciliationService,
  ],
})
export class ReconciliationModule {}

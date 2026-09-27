import { Module } from "@nestjs/common";
import { PaymentsModule } from "../payments/payments.module";
import { ContractAnchoringService } from "../proofs/contract-anchoring.service";
import { AnchoringReconcilerService } from "./anchoring-reconciler.service";
import { AnchoringWorkerService } from "./anchoring-worker.service";
import { PaymentBackfillWorkerService } from "./payment-backfill-worker.service";
import { RetentionCleanupService } from "./retention/retention-cleanup.service";
import { RetentionJob } from "./retention/retention.job";

@Module({
  imports: [PaymentsModule],
  providers: [
    ContractAnchoringService,
    AnchoringWorkerService,
    PaymentBackfillWorkerService,
    AnchoringReconcilerService,
    RetentionCleanupService,
    RetentionJob,
  ],
  exports: [
    AnchoringWorkerService,
    AnchoringReconcilerService,
    RetentionCleanupService,
  ],
})
export class JobsModule {}
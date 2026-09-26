import { Module } from "@nestjs/common";
import { IssuersModule } from "../issuers/issuers.module";
import { ContractAnchoringService } from "../proofs/contract-anchoring.service";
import { AnchoringReconcilerService } from "./anchoring-reconciler.service";
import { AnchoringWorkerService } from "./anchoring-worker.service";
import { IssuerAddressRotationJob } from "./issuer-address-rotation.job";
import { RetentionCleanupService } from "./retention/retention-cleanup.service";
import { RetentionJob } from "./retention/retention.job";

@Module({
  imports: [IssuersModule],
  providers: [
    ContractAnchoringService,
    AnchoringWorkerService,
    AnchoringReconcilerService,
    IssuerAddressRotationJob,
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
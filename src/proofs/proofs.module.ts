import { QuotasModule } from "../quotas/quotas.module";
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { AttestationsModule } from "../attestations/attestations.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { CredentialVerificationKeyService } from "../common/crypto/credential-verification-key.service";
import { ContractAnchoringService } from "./contract-anchoring.service";
import { ProofsController } from "./proofs.controller";
import { ProofsService } from "./proofs.service";
import { ProofSharingService } from "./proof-sharing.service";
import { ProofReconciliationService } from "./proof-reconciliation.service";
import { RevocationCheckpointService } from "./revocation-checkpoint.service";
import { RevocationCheckpointController } from "./revocation-checkpoint.controller";
import { ProofVerificationAbuseService } from "../common/rate-limit/proof-verification-abuse.service";

@Module({
  imports: [AuthModule, AuditModule, AttestationsModule, WebhooksModule],
  controllers: [ProofsController, RevocationCheckpointController],
  providers: [
    ContractAnchoringService,
    CredentialVerificationKeyService,
    ProofsService,
    ProofSharingService,
    ProofReconciliationService,
    RevocationCheckpointService,
    ProofVerificationAbuseService,
  ],
  exports: [
    ContractAnchoringService,
    CredentialVerificationKeyService,
    ProofSharingService,
    RevocationCheckpointService,
  ],
})
export class ProofsModule {}

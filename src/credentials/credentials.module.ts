import { Module } from "@nestjs/common";
import { ProofsModule } from "../proofs/proofs.module";
import { CredentialSigningKeyringService } from "../common/crypto/credential-signing-keyring.service";
import { CredentialVerificationKeyService } from "../common/crypto/credential-verification-key.service";
import { CredentialsController } from "./credentials.controller";
import { CredentialsService } from "./credentials.service";
import { EvidenceBundleService } from "./evidence-bundle.service";
import { CredentialQuarantineService } from "./credential-quarantine.service";
import { CredentialQuarantineController } from "./credential-quarantine.controller";
import { MultipartUploadService } from "./multipart-upload.service";
import { MultipartParserService } from "../common/uploads/multipart-parser.service";
import { ContentInspectionService } from "../common/uploads/content-inspection.service";
import { CredentialVerificationKeyTrustPinService } from "./credential-verification-key-trust-pin.service";

@Module({
  imports: [ProofsModule],
  controllers: [CredentialsController, CredentialQuarantineController],
  providers: [
    CredentialsService,
    CredentialSigningKeyringService,
    CredentialVerificationKeyService,
    EvidenceBundleService,
    CredentialQuarantineService,
    CredentialVerificationKeyTrustPinService,
    MultipartUploadService,
    MultipartParserService,
    ContentInspectionService,
  ],
  exports: [
    CredentialsService,
    CredentialSigningKeyringService,
    CredentialVerificationKeyService,
    EvidenceBundleService,
    CredentialQuarantineService,
    CredentialVerificationKeyTrustPinService,
    MultipartUploadService,
    MultipartParserService,
    ContentInspectionService,
  ],
})
export class CredentialsModule {}

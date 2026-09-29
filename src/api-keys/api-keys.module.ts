import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ApiKeyService } from "./api-key.service";
import { ApiKeyUsageService } from "./api-key-usage.service";
import { ApiKeysController } from "./api-keys.controller";
import { ApiKeyGuard } from "../common/guards/api-key.guard";
import { RequestSigningGuard } from "../common/guards/request-signing.guard";
import { ScopesGuard } from "../common/guards/scopes.guard";
import { RequestNonceService } from "./request-nonce.service";
import { IntegrationAuthController } from "./integration-auth.controller";

@Module({
  imports: [AuthModule],
  controllers: [ApiKeysController, IntegrationAuthController],
  providers: [ApiKeyService, ApiKeyUsageService, ApiKeyGuard, ScopesGuard],
  exports: [ApiKeyService, ApiKeyUsageService, ApiKeyGuard, ScopesGuard],
  providers: [
    ApiKeyService,
    ApiKeyGuard,
    RequestSigningGuard,
    RequestNonceService,
    ScopesGuard,
  ],
  exports: [ApiKeyService, ApiKeyGuard, RequestSigningGuard, RequestNonceService, ScopesGuard],
})
export class ApiKeysModule {}
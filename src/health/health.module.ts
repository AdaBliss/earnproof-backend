import { Module } from "@nestjs/common";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { DatabaseModule } from "../database/database.module";
import { ContractsModule } from "../contracts/contracts.module";
import { Clock, SystemClock } from "../common/time/clock";
import { ClockSkewMonitorService } from "./clock-skew-monitor.service";
import { SorobanRpcClient } from "../proofs/soroban/soroban-rpc.client";
import { ContractIdentityService } from "./contract-identity.service";
import { DeploymentMetadataService } from "./deployment-metadata.service";
import { HealthController } from "./health.controller";
import { IncidentsController } from "./incidents.controller";
import { HealthService } from "./health.service";
import { ProtocolPauseController } from "./protocol-pause.controller";
import { ProtocolPauseService } from "./protocol-pause.service";
import { PauseAcknowledgementController } from "./pause-acknowledgement.controller";
import { PauseAcknowledgementService } from "./pause-acknowledgement.service";

@Module({
  imports: [ApiKeysModule, DatabaseModule, ContractsModule],
  controllers: [
    HealthController,
    ProtocolPauseController,
    PauseAcknowledgementController,
  ],
  providers: [
    HealthService,
    DeploymentMetadataService,
    ProtocolPauseService,
    PauseAcknowledgementService,
    ClockSkewMonitorService,
    SorobanRpcClient,
    ContractIdentityService,
    { provide: Clock, useClass: SystemClock },
  ],
  exports: [
    HealthService,
    ProtocolPauseService,
    PauseAcknowledgementService,
    ClockSkewMonitorService,
    ContractIdentityService,
  ],
})
export class HealthModule {}

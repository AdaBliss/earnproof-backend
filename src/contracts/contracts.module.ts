import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { ContractSuccessorService } from "./contract-successor.service";
import { ContractsController } from "./contracts.controller";
import { ContractDecommissionController } from "./contract-decommission.controller";
import { ContractDecommissionService } from "./contract-decommission.service";

/**
 * Contracts Module
 *
 * Provides contract successor migration readiness assessment and management.
 * Integrates with governance and health modules to provide a coordinated view
 * of contract compatibility, pause state, migrations, and checkpoints.
 */
@Module({
  imports: [DatabaseModule, ApiKeysModule],
  providers: [ContractSuccessorService, ContractDecommissionService],
  controllers: [ContractsController, ContractDecommissionController],
  exports: [ContractSuccessorService, ContractDecommissionService],
})
export class ContractsModule {}

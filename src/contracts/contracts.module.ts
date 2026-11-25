import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { ContractSuccessorService } from "./contract-successor.service";
import { CapabilityBitmapService } from "./capability-bitmap.service";
import { ContractsController } from "./contracts.controller";
import { ContractDecommissionController } from "./contract-decommission.controller";
import { ContractDecommissionService } from "./contract-decommission.service";

/**
 * Contracts Module
 *
 * Provides contract successor migration readiness assessment and management.
 * Includes capability versioning and compatibility checking for services.
 *
 * Integrates with governance and health modules to provide a coordinated view
 * of contract compatibility, pause state, migrations, checkpoints, and capabilities.
 */
@Module({
  imports: [DatabaseModule, ApiKeysModule],
  providers: [ContractSuccessorService, CapabilityBitmapService],
  controllers: [ContractsController],
  exports: [ContractSuccessorService, CapabilityBitmapService],
})
export class ContractsModule {}

/**
 * Contracts module barrel file.
 * Exports public types and services for contract successor migration and capability versioning.
 */

export * from "./contracts.types";
export * from "./contracts.dto";
export * from "./capability-bitmap.types";
export { ContractSuccessorService } from "./contract-successor.service";
export { CapabilityBitmapService } from "./capability-bitmap.service";
export { ContractsModule } from "./contracts.module";

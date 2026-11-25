/**
 * Data Transfer Objects for capability bitmap versioning and compatibility endpoints.
 * These are used in API responses and maintain a public contract surface.
 */

import {
  CapabilityDefinition,
  CapabilityBitmapVersion,
  CapabilityCompatibilityCheck,
} from "./capability-bitmap.types";

/**
 * DTO for a single capability definition.
 */
export class CapabilityDefinitionResponse implements CapabilityDefinition {
  bitPosition: number;
  name: string;
  description: string;
  introducedInVersion: number;
  severity: "blocking" | "advisory";
  required: boolean;
}

/**
 * DTO for a versioned capability bitmap.
 */
export class CapabilityBitmapVersionResponse implements CapabilityBitmapVersion {
  schemaVersion: number;
  /** Bitmap as a string representation for JSON serialization */
  bitmap: string; // bigint cannot be JSON serialized, use string
  definedAt: string;
  capabilities: CapabilityDefinitionResponse[];
}

/**
 * DTO for checking capability compatibility.
 * Request body for POST /contracts/capability-check.
 */
export class CheckCapabilityCompatibilityRequest {
  /** Service identifier (e.g., "webhook_sender", "checkpoint_monitor") */
  serviceId: string;
  /** Contract schema version */
  schemaVersion: number;
  /** Contract capability bitmap as a string (JSON-safe bigint) */
  contractBitmap: string;
}

/**
 * DTO for capability compatibility check response.
 */
export class CapabilityCompatibilityResponse implements CapabilityCompatibilityCheck {
  serviceId: string;
  schemaVersion: number;
  /** Bitmap as a string for JSON serialization */
  contractBitmap: string; // bigint converted to string
  requiredCapabilities: CapabilityDefinitionResponse[];
  hasCapabilities: CapabilityDefinitionResponse[];
  missingCapabilities: CapabilityDefinitionResponse[];
  missingAdvisory: CapabilityDefinitionResponse[];
  compatible: boolean;
  reasonCode?: string;
  reason?: string;
}

/**
 * DTO for the capability bitmap index metadata.
 */
export class CapabilityBitmapIndexMetadataResponse {
  formatVersion: number;
  capabilityCount: number;
  versionCount: number;
  loadedAt: string;
  /** Age of the index in milliseconds */
  ageMs: number;
}

/**
 * DTO for listing all capabilities.
 */
export class ListCapabilitiesResponse {
  total: number;
  capabilities: CapabilityDefinitionResponse[];
}

/**
 * DTO for listing all versioned capability bitmaps.
 */
export class ListCapabilityVersionsResponse {
  total: number;
  versions: CapabilityBitmapVersionResponse[];
}

/**
 * Capability bitmap versioning and compatibility types.
 *
 * A capability bitmap is a fixed-width set of bits, each representing a distinct
 * contract capability or feature. Bitmaps are versioned, and services must
 * declare their requirements before calling optional contract entrypoints.
 *
 * Design principles:
 * - Unknown bits are preserved (never masked out)
 * - Missing required capabilities block unsafe calls
 * - Bitmaps are deterministic and version-bound
 * - Compatibility checks are synchronous and observable
 * - Privacy-safe: no secrets, addresses, or raw values
 */

/**
 * A single capability bit with version history and metadata.
 */
export interface CapabilityDefinition {
  /** Bit position (0-63 for 64-bit bitmap). Immutable once assigned. */
  bitPosition: number;
  /** Human-readable name (e.g., "webhook_retry_policy") */
  name: string;
  /** Detailed description of what this capability enables */
  description: string;
  /** Which schema version introduced this capability */
  introducedInVersion: number;
  /** Severity if missing: "blocking" (unsafe calls fail) or "advisory" (warnings only) */
  severity: "blocking" | "advisory";
  /** Whether this capability is required for basic operation */
  required: boolean;
}

/**
 * A single capability bitmap version tied to a contract schema version.
 */
export interface CapabilityBitmapVersion {
  /** Contract schema version (immutable identifier) */
  schemaVersion: number;
  /** The capability bitmap as a bigint (can represent 64 bits) */
  bitmap: bigint;
  /** Timestamp when this version was defined (ISO-8601) */
  definedAt: string;
  /** Which capabilities are included in this bitmap */
  capabilities: CapabilityDefinition[];
}

/**
 * Service capability requirement: what this service needs to operate safely.
 */
export interface ServiceCapabilityRequirement {
  /** Unique service identifier (e.g., "webhook_sender", "checkpoint_monitor") */
  serviceId: string;
  /** Bitmap of required capabilities */
  requiredBitmap: bigint;
  /** Bitmap of advisory capabilities (nice to have, but not blocking) */
  advisoryBitmap: bigint;
  /** Which contract schema versions this requirement applies to */
  applicableSchemaVersions: number[];
}

/**
 * Result of a capability compatibility check.
 */
export interface CapabilityCompatibilityCheck {
  /** The service being evaluated */
  serviceId: string;
  /** The contract schema version being checked */
  schemaVersion: number;
  /** The contract's capability bitmap */
  contractBitmap: bigint;
  /** Required capabilities for this service */
  requiredCapabilities: CapabilityDefinition[];
  /** Capabilities the contract has that this service requires */
  hasCapabilities: CapabilityDefinition[];
  /** Capabilities the contract is missing that this service requires */
  missingCapabilities: CapabilityDefinition[];
  /** Advisory capabilities the contract is missing */
  missingAdvisory: CapabilityDefinition[];
  /** Whether the contract has all required capabilities */
  compatible: boolean;
  /** Stable reason code if incompatible */
  reasonCode?: string;
  /** Human-readable reason if incompatible */
  reason?: string;
}

/**
 * Bitmap index for all defined capabilities and versions.
 * This is the source of truth for capability definitions.
 */
export interface CapabilityBitmapIndex {
  /** Index format version (for migration if needed) */
  formatVersion: 1;
  /** All defined capabilities across all versions */
  definitions: Record<string, CapabilityDefinition>;
  /** Versioned bitmaps for each contract schema version */
  versions: CapabilityBitmapVersion[];
}

/**
 * Stability codes for capability compatibility issues.
 */
export const CapabilityCompatibilityStatusCode = {
  /** All required capabilities present */
  COMPATIBLE: "compatible",
  /** Contract missing one or more required capabilities */
  MISSING_REQUIRED: "missing_required_capabilities",
  /** Contract schema version not indexed */
  UNKNOWN_VERSION: "unknown_schema_version",
  /** Service capability requirement not found */
  UNKNOWN_SERVICE: "unknown_service",
  /** Bitmap index is stale or uninitialized */
  INDEX_STALE: "bitmap_index_stale",
} as const;

export type CapabilityCompatibilityStatusCodeValue =
  (typeof CapabilityCompatibilityStatusCode)[keyof typeof CapabilityCompatibilityStatusCode];

/**
 * A set of common contract capability names and positions.
 * This is a reference; the actual bitmap index defines the source of truth.
 */
export const CommonCapabilities = {
  WEBHOOK_RETRY_POLICY: { name: "webhook_retry_policy", bitPosition: 0 },
  CHECKPOINT_MIGRATION: { name: "checkpoint_migration", bitPosition: 1 },
  PAUSE_STATE_RECOVERY: { name: "pause_state_recovery", bitPosition: 2 },
  LEDGER_MONOTONICITY: { name: "ledger_monotonicity", bitPosition: 3 },
  PAYMENT_CHECKPOINT: { name: "payment_checkpoint", bitPosition: 4 },
  DISPUTE_NOTIFICATION: { name: "dispute_notification", bitPosition: 5 },
  CREDENTIAL_FRESH_CHECK: { name: "credential_fresh_check", bitPosition: 6 },
  PROVISIONAL_PAYMENT: { name: "provisional_payment", bitPosition: 7 },
} as const;

/**
 * Build a bitmap from a list of bit positions.
 * Used to construct service requirements and index entries.
 *
 * @param positions Array of bit positions (0-63)
 * @returns A bigint representing the bitmap
 * @throws Error if any position is out of range
 */
export function buildBitmap(positions: number[]): bigint {
  let bitmap = 0n;
  for (const pos of positions) {
    if (pos < 0 || pos > 63) {
      throw new Error(`Bit position ${pos} out of range [0, 63]`);
    }
    bitmap |= 1n << BigInt(pos);
  }
  return bitmap;
}

/**
 * Check if a bitmap has all bits set from a requirement bitmap.
 *
 * @param contractBitmap The contract's capability bitmap
 * @param requiredBitmap The required capabilities bitmap
 * @returns True if contractBitmap has all bits from requiredBitmap set
 */
export function hasBitmap(
  contractBitmap: bigint,
  requiredBitmap: bigint,
): boolean {
  return (contractBitmap & requiredBitmap) === requiredBitmap;
}

/**
 * Extract individual bit positions that are set in a bitmap.
 *
 * @param bitmap The bitmap to extract positions from
 * @returns Array of set bit positions
 */
export function extractSetBits(bitmap: bigint): number[] {
  const positions: number[] = [];
  for (let i = 0n; i < 64n; i += 1n) {
    if ((bitmap & (1n << i)) !== 0n) {
      positions.push(Number(i));
    }
  }
  return positions;
}

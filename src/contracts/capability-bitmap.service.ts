import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CapabilityBitmapIndex,
  CapabilityBitmapVersion,
  CapabilityCompatibilityCheck,
  CapabilityCompatibilityStatusCode,
  CapabilityDefinition,
  ServiceCapabilityRequirement,
  CommonCapabilities,
  buildBitmap,
  hasBitmap,
  extractSetBits,
} from "./capability-bitmap.types";

/**
 * Default capability bitmap index if none is configured.
 * Defines the baseline capabilities for the EarnProof contract suite.
 */
function getDefaultCapabilityIndex(): CapabilityBitmapIndex {
  return {
    formatVersion: 1,
    definitions: {
      [CommonCapabilities.WEBHOOK_RETRY_POLICY.name]: {
        bitPosition: CommonCapabilities.WEBHOOK_RETRY_POLICY.bitPosition,
        name: CommonCapabilities.WEBHOOK_RETRY_POLICY.name,
        description:
          "Contract supports webhook retry policy with exponential backoff and deadletter handling",
        introducedInVersion: 1,
        severity: "advisory",
        required: false,
      },
      [CommonCapabilities.CHECKPOINT_MIGRATION.name]: {
        bitPosition: CommonCapabilities.CHECKPOINT_MIGRATION.bitPosition,
        name: CommonCapabilities.CHECKPOINT_MIGRATION.name,
        description:
          "Contract supports migrating checkpoints from predecessor without data loss",
        introducedInVersion: 1,
        severity: "blocking",
        required: true,
      },
      [CommonCapabilities.PAUSE_STATE_RECOVERY.name]: {
        bitPosition: CommonCapabilities.PAUSE_STATE_RECOVERY.bitPosition,
        name: CommonCapabilities.PAUSE_STATE_RECOVERY.name,
        description: "Contract can recover from paused state while maintaining consistency",
        introducedInVersion: 1,
        severity: "advisory",
        required: false,
      },
      [CommonCapabilities.LEDGER_MONOTONICITY.name]: {
        bitPosition: CommonCapabilities.LEDGER_MONOTONICITY.bitPosition,
        name: CommonCapabilities.LEDGER_MONOTONICITY.name,
        description:
          "Contract guarantees ledger sequence numbers are monotonically increasing",
        introducedInVersion: 1,
        severity: "blocking",
        required: true,
      },
      [CommonCapabilities.PAYMENT_CHECKPOINT.name]: {
        bitPosition: CommonCapabilities.PAYMENT_CHECKPOINT.bitPosition,
        name: CommonCapabilities.PAYMENT_CHECKPOINT.name,
        description:
          "Contract can checkpoint payment state at arbitrary ledger sequences",
        introducedInVersion: 1,
        severity: "blocking",
        required: true,
      },
      [CommonCapabilities.DISPUTE_NOTIFICATION.name]: {
        bitPosition: CommonCapabilities.DISPUTE_NOTIFICATION.bitPosition,
        name: CommonCapabilities.DISPUTE_NOTIFICATION.name,
        description:
          "Contract emits events when payment disputes are created or resolved",
        introducedInVersion: 2,
        severity: "advisory",
        required: false,
      },
      [CommonCapabilities.CREDENTIAL_FRESH_CHECK.name]: {
        bitPosition: CommonCapabilities.CREDENTIAL_FRESH_CHECK.bitPosition,
        name: CommonCapabilities.CREDENTIAL_FRESH_CHECK.name,
        description:
          "Contract supports checking credential freshness at contract-time",
        introducedInVersion: 2,
        severity: "advisory",
        required: false,
      },
      [CommonCapabilities.PROVISIONAL_PAYMENT.name]: {
        bitPosition: CommonCapabilities.PROVISIONAL_PAYMENT.bitPosition,
        name: CommonCapabilities.PROVISIONAL_PAYMENT.name,
        description:
          "Contract can create provisional payments pending final settlement",
        introducedInVersion: 3,
        severity: "advisory",
        required: false,
      },
    },
    versions: [
      {
        schemaVersion: 1,
        bitmap: buildBitmap([0, 1, 3, 4]),
        definedAt: new Date(2024, 0, 1).toISOString(),
        capabilities: [
          { ...CommonCapabilities.WEBHOOK_RETRY_POLICY, name: "webhook_retry_policy" } as any,
          { ...CommonCapabilities.CHECKPOINT_MIGRATION, name: "checkpoint_migration" } as any,
          { ...CommonCapabilities.LEDGER_MONOTONICITY, name: "ledger_monotonicity" } as any,
          { ...CommonCapabilities.PAYMENT_CHECKPOINT, name: "payment_checkpoint" } as any,
        ],
      },
      {
        schemaVersion: 2,
        bitmap: buildBitmap([0, 1, 2, 3, 4, 5, 6]),
        definedAt: new Date(2024, 6, 1).toISOString(),
        capabilities: [
          { ...CommonCapabilities.WEBHOOK_RETRY_POLICY, name: "webhook_retry_policy" } as any,
          { ...CommonCapabilities.CHECKPOINT_MIGRATION, name: "checkpoint_migration" } as any,
          { ...CommonCapabilities.PAUSE_STATE_RECOVERY, name: "pause_state_recovery" } as any,
          { ...CommonCapabilities.LEDGER_MONOTONICITY, name: "ledger_monotonicity" } as any,
          { ...CommonCapabilities.PAYMENT_CHECKPOINT, name: "payment_checkpoint" } as any,
          { ...CommonCapabilities.DISPUTE_NOTIFICATION, name: "dispute_notification" } as any,
          {
            ...CommonCapabilities.CREDENTIAL_FRESH_CHECK,
            name: "credential_fresh_check",
          } as any,
        ],
      },
      {
        schemaVersion: 3,
        bitmap: buildBitmap([0, 1, 2, 3, 4, 5, 6, 7]),
        definedAt: new Date(2025, 0, 1).toISOString(),
        capabilities: [
          { ...CommonCapabilities.WEBHOOK_RETRY_POLICY, name: "webhook_retry_policy" } as any,
          { ...CommonCapabilities.CHECKPOINT_MIGRATION, name: "checkpoint_migration" } as any,
          { ...CommonCapabilities.PAUSE_STATE_RECOVERY, name: "pause_state_recovery" } as any,
          { ...CommonCapabilities.LEDGER_MONOTONICITY, name: "ledger_monotonicity" } as any,
          { ...CommonCapabilities.PAYMENT_CHECKPOINT, name: "payment_checkpoint" } as any,
          { ...CommonCapabilities.DISPUTE_NOTIFICATION, name: "dispute_notification" } as any,
          {
            ...CommonCapabilities.CREDENTIAL_FRESH_CHECK,
            name: "credential_fresh_check",
          } as any,
          { ...CommonCapabilities.PROVISIONAL_PAYMENT, name: "provisional_payment" } as any,
        ],
      },
    ],
  };
}

/**
 * CapabilityBitmapService
 *
 * Manages contract capability versioning and compatibility checking.
 * Services declare their capability requirements, and this service verifies
 * that contracts provide the necessary capabilities before allowing unsafe operations.
 *
 * Design patterns:
 * - Deterministic: same inputs always produce same results
 * - Observable: all operations can be traced for debugging
 * - Bounded: checks complete immediately, no external I/O
 * - Privacy-safe: no secrets or raw values in findings
 * - Unknown-preserving: unknown bits in contract bitmaps are never masked out
 */
@Injectable()
export class CapabilityBitmapService {
  private readonly logger = new Logger(CapabilityBitmapService.name);
  private index: CapabilityBitmapIndex;
  private requirementsMap: Map<string, ServiceCapabilityRequirement> = new Map();
  private indexLoadedAt: number = 0;

  constructor(private readonly config: ConfigService) {
    this.index = getDefaultCapabilityIndex();
    this.indexLoadedAt = Date.now();
    this.registerDefaultRequirements();
  }

  /**
   * Check if a contract with given schema version and bitmap satisfies
   * the requirements of a specific service.
   *
   * @param serviceId The service making the call
   * @param schemaVersion The contract's schema version
   * @param contractBitmap The contract's capability bitmap
   * @returns Detailed compatibility check result
   */
  checkCompatibility(
    serviceId: string,
    schemaVersion: number,
    contractBitmap: bigint,
  ): CapabilityCompatibilityCheck {
    // Find schema version in index
    const versionEntry = this.index.versions.find((v) => v.schemaVersion === schemaVersion);
    if (!versionEntry) {
      return {
        serviceId,
        schemaVersion,
        contractBitmap,
        requiredCapabilities: [],
        hasCapabilities: [],
        missingCapabilities: [],
        missingAdvisory: [],
        compatible: false,
        reasonCode: CapabilityCompatibilityStatusCode.UNKNOWN_VERSION,
        reason: `Schema version ${schemaVersion} not found in capability index`,
      };
    }

    // Find service requirements
    const requirement = this.requirementsMap.get(serviceId);
    if (!requirement) {
      return {
        serviceId,
        schemaVersion,
        contractBitmap,
        requiredCapabilities: [],
        hasCapabilities: [],
        missingCapabilities: [],
        missingAdvisory: [],
        compatible: false,
        reasonCode: CapabilityCompatibilityStatusCode.UNKNOWN_SERVICE,
        reason: `Service ${serviceId} has no capability requirements registered`,
      };
    }

    // Check if schema version applies to this requirement
    if (!requirement.applicableSchemaVersions.includes(schemaVersion)) {
      return {
        serviceId,
        schemaVersion,
        contractBitmap,
        requiredCapabilities: [],
        hasCapabilities: [],
        missingCapabilities: [],
        missingAdvisory: [],
        compatible: true,
        reasonCode: CapabilityCompatibilityStatusCode.COMPATIBLE,
        reason: "Service requirements do not apply to this schema version",
      };
    }

    // Extract required capabilities
    const requiredPositions = extractSetBits(requirement.requiredBitmap);
    const requiredCapabilities = requiredPositions
      .map((pos) => this.findCapabilityAt(pos))
      .filter((cap): cap is CapabilityDefinition => cap !== null);

    // Extract advisory capabilities
    const advisoryPositions = extractSetBits(requirement.advisoryBitmap);
    const advisoryCapabilities = advisoryPositions
      .map((pos) => this.findCapabilityAt(pos))
      .filter((cap): cap is CapabilityDefinition => cap !== null);

    // Check which required capabilities are present
    const hasCapabilities = requiredCapabilities.filter((cap) =>
      this.hasBit(contractBitmap, cap.bitPosition),
    );
    const missingCapabilities = requiredCapabilities.filter(
      (cap) => !this.hasBit(contractBitmap, cap.bitPosition),
    );

    // Check which advisory capabilities are missing
    const missingAdvisory = advisoryCapabilities.filter(
      (cap) => !this.hasBit(contractBitmap, cap.bitPosition),
    );

    const compatible = missingCapabilities.length === 0;

    return {
      serviceId,
      schemaVersion,
      contractBitmap,
      requiredCapabilities,
      hasCapabilities,
      missingCapabilities,
      missingAdvisory,
      compatible,
      reasonCode: compatible ? CapabilityCompatibilityStatusCode.COMPATIBLE : CapabilityCompatibilityStatusCode.MISSING_REQUIRED,
      reason: compatible
        ? undefined
        : `Missing required capabilities: ${missingCapabilities.map((c) => c.name).join(", ")}`,
    };
  }

  /**
   * Get the capability bitmap for a specific schema version.
   *
   * @param schemaVersion The contract schema version
   * @returns The bitmap, or null if version not found
   */
  getBitmapForVersion(schemaVersion: number): bigint | null {
    const version = this.index.versions.find((v) => v.schemaVersion === schemaVersion);
    return version?.bitmap ?? null;
  }

  /**
   * Get all capability definitions.
   */
  getAllCapabilities(): CapabilityDefinition[] {
    return Object.values(this.index.definitions);
  }

  /**
   * Get capability definition by name.
   */
  getCapabilityByName(name: string): CapabilityDefinition | null {
    return this.index.definitions[name] ?? null;
  }

  /**
   * Get all capability versions.
   */
  getCapabilityVersions(): CapabilityBitmapVersion[] {
    return this.index.versions;
  }

  /**
   * Get index freshness metadata.
   */
  getIndexMetadata() {
    return {
      formatVersion: this.index.formatVersion,
      capabilityCount: Object.keys(this.index.definitions).length,
      versionCount: this.index.versions.length,
      loadedAt: new Date(this.indexLoadedAt).toISOString(),
      ageMs: Date.now() - this.indexLoadedAt,
    };
  }

  /**
   * Register a service's capability requirements.
   * Called during initialization and before service operation.
   */
  registerRequirement(requirement: ServiceCapabilityRequirement): void {
    this.requirementsMap.set(requirement.serviceId, requirement);
    this.logger.debug(
      `Registered capability requirement for service ${requirement.serviceId}: ` +
        `required=${requirement.requiredBitmap.toString(2)}, ` +
        `advisory=${requirement.advisoryBitmap.toString(2)}`,
    );
  }

  /**
   * Reset requirements (primarily for testing).
   */
  resetRequirements(): void {
    this.requirementsMap.clear();
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  /**
   * Check if a single bit is set in a bitmap.
   */
  private hasBit(bitmap: bigint, position: number): boolean {
    if (position < 0 || position > 63) {
      return false;
    }
    return (bitmap & (1n << BigInt(position))) !== 0n;
  }

  /**
   * Find a capability definition by bit position.
   */
  private findCapabilityAt(position: number): CapabilityDefinition | null {
    for (const def of Object.values(this.index.definitions)) {
      if (def.bitPosition === position) {
        return def;
      }
    }
    return null;
  }

  /**
   * Register default service capability requirements.
   */
  private registerDefaultRequirements(): void {
    // Webhook sender service
    this.registerRequirement({
      serviceId: "webhook_sender",
      requiredBitmap: buildBitmap([1, 3]), // CHECKPOINT_MIGRATION, LEDGER_MONOTONICITY
      advisoryBitmap: buildBitmap([0]), // WEBHOOK_RETRY_POLICY
      applicableSchemaVersions: [1, 2, 3],
    });

    // Payment checkpoint monitor
    this.registerRequirement({
      serviceId: "checkpoint_monitor",
      requiredBitmap: buildBitmap([1, 4]), // CHECKPOINT_MIGRATION, PAYMENT_CHECKPOINT
      advisoryBitmap: buildBitmap([3]), // LEDGER_MONOTONICITY
      applicableSchemaVersions: [1, 2, 3],
    });

    // Dispute notification service
    this.registerRequirement({
      serviceId: "dispute_notifier",
      requiredBitmap: buildBitmap([]), // No hard requirements
      advisoryBitmap: buildBitmap([5]), // DISPUTE_NOTIFICATION
      applicableSchemaVersions: [2, 3],
    });

    // Credential verifier
    this.registerRequirement({
      serviceId: "credential_verifier",
      requiredBitmap: buildBitmap([]), // No hard requirements
      advisoryBitmap: buildBitmap([6]), // CREDENTIAL_FRESH_CHECK
      applicableSchemaVersions: [2, 3],
    });

    // Provisional payment handler
    this.registerRequirement({
      serviceId: "provisional_payment_handler",
      requiredBitmap: buildBitmap([1, 3, 4]), // CHECKPOINT_MIGRATION, LEDGER_MONOTONICITY, PAYMENT_CHECKPOINT
      advisoryBitmap: buildBitmap([7]), // PROVISIONAL_PAYMENT
      applicableSchemaVersions: [3],
    });
  }
}

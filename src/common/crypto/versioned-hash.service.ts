/**
 * Service for versioned token hashing with metrics and progressive upgrade.
 *
 * Responsibility:
 * - Hash new tokens with the current policy version
 * - Verify tokens against any supported version
 * - Emit metrics on version usage (weak vs current)
 * - Support progressive upgrade: re-hash old-version tokens on successful verify
 * - Fail closed: unknown versions always throw
 */

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  HASH_POLICIES,
  CURRENT_HASH_VERSION,
  HashAlgorithmVersion,
  HashPolicyConfig,
  hashWithCurrentVersion,
  verifyVersionedHash,
  isWeakVersion,
  formatVersionedHash,
  parseVersionedHash,
  VersionedHash,
} from "./hash-policy";

export interface VersionedHashMetrics {
  tokenType: string;           // "session", "proof_share", "recent_auth", etc.
  version: HashAlgorithmVersion;
  outcome: "valid" | "invalid" | "unknown_version";
  isWeak: boolean;
}

export interface VerifyResult {
  valid: boolean;
  version: HashAlgorithmVersion;
  needsUpgrade: boolean;
  newHash?: string;            // If valid and weak version, the upgraded hash
}

@Injectable()
export class VersionedHashService {
  private readonly logger = new Logger(VersionedHashService.name);
  private readonly config: HashPolicyConfig;

  constructor(configService: ConfigService) {
    this.validateConfiguration(configService);
    this.config = {
      minimumVersion: this.parseIntEnv(
        configService,
        "HASH_POLICY_MIN_VERSION",
        HashAlgorithmVersion.V2_PBKDF2_SHA256,
      ),
      pbkdf2Iterations: this.parseIntEnv(
        configService,
        "HASH_POLICY_PBKDF2_ITERATIONS",
        100000,
      ),
      rejectWeakVersions: configService.get<string>(
        "HASH_POLICY_REJECT_WEAK",
        "false",
      ) === "true",
    };

    // Fail closed: reject misconfiguration
    if (this.config.minimumVersion < HashAlgorithmVersion.V1_SHA256) {
      throw new Error(
        `HASH_POLICY_MIN_VERSION must be >= 1, got ${this.config.minimumVersion}`,
      );
    }
    if (
      this.config.minimumVersion > CURRENT_HASH_VERSION &&
      !this.config.rejectWeakVersions
    ) {
      this.logger.warn(
        `HASH_POLICY_MIN_VERSION (${this.config.minimumVersion}) ` +
        `is above CURRENT_HASH_VERSION (${CURRENT_HASH_VERSION}). ` +
        `No token can ever pass validation. Either lower the minimum or enable HASH_POLICY_REJECT_WEAK.`,
      );
    }

    this.logger.log(
      `Hash policy initialized: min=${this.config.minimumVersion}, ` +
      `current=${CURRENT_HASH_VERSION}, ` +
      `rejectWeak=${this.config.rejectWeakVersions}`,
    );
  }

  /**
   * Hash a plaintext token value with the current policy.
   * Use this when creating new tokens.
   *
   * @returns Formatted versioned hash ready for storage (e.g., "v2:salt:key")
   */
  hashToken(plaintext: string): string {
    return hashWithCurrentVersion(plaintext);
  }

  /**
   * Verify a plaintext token against a stored versioned hash.
   * Returns detailed result including upgrade recommendation.
   *
   * On success:
   *   - If token uses current version: returns { valid: true, version: CURRENT, needsUpgrade: false }
   *   - If token uses old version: returns { valid: true, version: OLD, needsUpgrade: true, newHash: "..." }
   *
   * On failure:
   *   - Returns { valid: false, version: X, needsUpgrade: false }
   *
   * On unknown version:
   *   - Throws error (fail-closed)
   *
   * @param plaintext The raw token string (never stored in DB)
   * @param storedHash The formatted versioned hash from DB
   * @returns Verification result with upgrade flag
   */
  verifyToken(plaintext: string, storedHash: string): VerifyResult {
    let result: ReturnType<typeof verifyVersionedHash>;

    try {
      result = verifyVersionedHash(plaintext, storedHash);
    } catch (error) {
      // Unknown version: fail closed
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Hash verification failed with unknown version: ${message}`);
      throw error;
    }

    const isWeak = isWeakVersion(result.version, this.config);

    // If weak version policy is "reject", fail now
    if (!result.valid) {
      return {
        valid: false,
        version: result.version,
        needsUpgrade: false,
      };
    }

    if (this.config.rejectWeakVersions && isWeak) {
      this.logger.warn(
        `Weak hash version ${result.version} rejected (minimum required: ${this.config.minimumVersion})`,
      );
      return {
        valid: false,
        version: result.version,
        needsUpgrade: false,
      };
    }

    // Valid token; check if upgrade is needed
    const needsUpgrade = result.version < CURRENT_HASH_VERSION;
    const newHash = needsUpgrade ? hashWithCurrentVersion(plaintext) : undefined;

    if (needsUpgrade) {
      this.logger.debug(
        `Valid token verified with old version ${result.version}; ` +
        `will upgrade to ${CURRENT_HASH_VERSION} on next persistence`,
      );
    }

    return {
      valid: true,
      version: result.version,
      needsUpgrade,
      newHash,
    };
  }

  /**
   * Emit low-cardinality metrics for token verification outcomes.
   * Never includes token values, hashes, user IDs, tenant IDs, or other PII.
   *
   * Labels:
   *   - tokenType: classification (low-cardinality: "session", "proof_share", etc.)
   *   - version: hash algorithm version
   *   - outcome: "valid" | "invalid" | "unknown_version" (low-cardinality)
   *   - isWeak: "true" | "false" (weak version per policy)
   *
   * This is where you'd record prometheus metrics, cloudwatch, datadog, etc.
   */
  recordMetric(metrics: VersionedHashMetrics): void {
    const { tokenType, version, outcome, isWeak } = metrics;

    this.logger.debug(
      `Token verification: type=${tokenType}, version=${version}, ` +
      `outcome=${outcome}, weak=${isWeak}`,
    );

    // TODO: Emit to metrics backend (prometheus, datadog, etc.)
    // Example:
    // this.metricsService.counter("token_verification_total", 1, {
    //   token_type: tokenType,
    //   version: String(version),
    //   outcome,
    //   is_weak: String(isWeak),
    // });

    if (outcome === "unknown_version") {
      this.logger.error(
        `Unknown hash version encountered: ${version}. This should not happen.`,
      );
    }

    if (isWeak && outcome === "valid") {
      this.logger.warn(
        `Token verified with weak version ${version} (below minimum ${this.config.minimumVersion}). ` +
        `Type: ${tokenType}. Token will be upgraded on next persistence.`,
      );
    }
  }

  /** Get the current policy configuration (for tests). */
  getConfig(): HashPolicyConfig {
    return { ...this.config };
  }

  /** Get all supported policies (for tests/admin). */
  getPolicies(): Record<HashAlgorithmVersion, typeof HASH_POLICIES[HashAlgorithmVersion]> {
    return { ...HASH_POLICIES };
  }

  /**
   * Validate that all policy versions are consistent.
   * Called at startup to fail fast on configuration issues.
   */
  private validateConfiguration(configService: ConfigService): void {
    // Check that CURRENT_HASH_VERSION exists in HASH_POLICIES
    if (!(CURRENT_HASH_VERSION in HASH_POLICIES)) {
      throw new Error(
        `CURRENT_HASH_VERSION (${CURRENT_HASH_VERSION}) is not defined in HASH_POLICIES`,
      );
    }

    // Check that all policy versions are valid enums
    for (const version of Object.keys(HASH_POLICIES)) {
      const v = parseInt(version, 10);
      if (!Object.values(HashAlgorithmVersion).includes(v)) {
        throw new Error(`Invalid policy version in registry: ${v}`);
      }
    }
  }

  private parseIntEnv(
    configService: ConfigService,
    key: string,
    defaultValue: number,
  ): number {
    const value = configService.get<string>(key);
    if (!value) {
      return defaultValue;
    }
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
      throw new Error(`${key} must be an integer, got "${value}"`);
    }
    return parsed;
  }
}

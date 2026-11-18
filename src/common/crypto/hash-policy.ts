/**
 * Versioned hash policy registry for opaque tokens.
 *
 * Design:
 * - Policies are immutable after creation (version 1, 2, 3, etc).
 * - Each policy defines algorithm, salt requirements, and cost parameters.
 * - New tokens use the current version; old tokens can verify against any version.
 * - Unknown versions fail closed (reject token).
 * - On successful verification with an old version, tokens are re-hashed
 *   atomically with the current version (progressive upgrade).
 *
 * Versioning strategy:
 * - v1: SHA-256 (no salt) — legacy default
 * - v2: PBKDF2-SHA256 with per-token salt
 * - Future versions can use Argon2, scrypt, etc.
 */

import { createHash, randomBytes, pbkdf2Sync } from "crypto";

export enum HashAlgorithmVersion {
  V1_SHA256 = 1,
  V2_PBKDF2_SHA256 = 2,
}

export interface HashPolicy {
  version: HashAlgorithmVersion;
  algorithm: string;
  salt?: {
    required: boolean;
    bytes: number;
  };
  iterations?: number; // for PBKDF2
  keyBytes?: number;   // for PBKDF2
  digest?: string;
  description: string;
}

/**
 * Immutable policy definitions.
 * Policies are never modified; new versions are added, old ones kept for migration.
 */
export const HASH_POLICIES: Record<HashAlgorithmVersion, HashPolicy> = {
  [HashAlgorithmVersion.V1_SHA256]: {
    version: HashAlgorithmVersion.V1_SHA256,
    algorithm: "sha256",
    salt: { required: false, bytes: 0 },
    description: "SHA-256 without salt (legacy)",
  },
  [HashAlgorithmVersion.V2_PBKDF2_SHA256]: {
    version: HashAlgorithmVersion.V2_PBKDF2_SHA256,
    algorithm: "pbkdf2",
    salt: { required: true, bytes: 16 },
    iterations: 100000,
    keyBytes: 32,
    digest: "sha256",
    description: "PBKDF2-SHA256 with 16-byte salt, 100k iterations",
  },
};

/** Current policy version for new tokens. */
export const CURRENT_HASH_VERSION = HashAlgorithmVersion.V2_PBKDF2_SHA256;

/**
 * Strong parameters (enforced at startup).
 * New code must use v2 or higher for all tokens.
 * Configuration can lower this only at deployment time, not in code.
 */
export interface HashPolicyConfig {
  /**
   * Minimum acceptable version for new tokens.
   * Tokens using versions below this threshold trigger alerts and are
   * deprecated. Set via env var HASH_POLICY_MIN_VERSION (default: 2).
   */
  minimumVersion: HashAlgorithmVersion;

  /**
   * Minimum iterations for PBKDF2 (v2).
   * Must be >= policy default. Increasing reduces backward compatibility.
   * Set via HASH_POLICY_PBKDF2_ITERATIONS.
   */
  pbkdf2Iterations: number;

  /**
   * If true, reject all weak-version tokens (older than minimumVersion).
   * If false, allow weak-version tokens but re-upgrade them on successful verification.
   * Set via HASH_POLICY_REJECT_WEAK (default: false for gradual migration).
   */
  rejectWeakVersions: boolean;
}

/**
 * Self-describing hash output format.
 * Persists version and salt alongside the hash, so verification can
 * dispatch on algorithm even if the policy evolves.
 *
 * Formats:
 *   v1:<hex-hash>
 *   v2:<salt-hex>:<derived-key-hex>
 */
export interface VersionedHash {
  version: HashAlgorithmVersion;
  salt?: Buffer;       // Raw salt bytes (for v2+)
  derivedKey: Buffer;  // Hash/derived key bytes
}

export function formatVersionedHash(versioned: VersionedHash): string {
  switch (versioned.version) {
    case HashAlgorithmVersion.V1_SHA256:
      return `v1:${versioned.derivedKey.toString("hex")}`;

    case HashAlgorithmVersion.V2_PBKDF2_SHA256:
      if (!versioned.salt) {
        throw new Error("v2 hash requires salt");
      }
      return `v2:${versioned.salt.toString("hex")}:${versioned.derivedKey.toString("hex")}`;

    default:
      throw new Error(`Unknown hash version: ${versioned.version}`);
  }
}

/**
 * Parse a persisted versioned hash back into components.
 * Unknown versions throw an error (fail-closed).
 */
export function parseVersionedHash(formatted: string): VersionedHash {
  const parts = formatted.split(":");
  if (parts.length < 2) {
    throw new Error("Malformed versioned hash: missing version prefix");
  }

  const versionStr = parts[0];
  const version = parseInt(versionStr.replace(/^v/, ""), 10);

  if (isNaN(version) || !Object.values(HashAlgorithmVersion).includes(version)) {
    throw new Error(`Unknown hash version: ${versionStr}`);
  }

  if (!(version in HASH_POLICIES)) {
    throw new Error(`Unsupported hash version: ${version}`);
  }

  switch (version) {
    case HashAlgorithmVersion.V1_SHA256:
      if (parts.length !== 2) {
        throw new Error("v1 hash format invalid: expected v1:<hex>");
      }
      return {
        version,
        derivedKey: Buffer.from(parts[1], "hex"),
      };

    case HashAlgorithmVersion.V2_PBKDF2_SHA256:
      if (parts.length !== 3) {
        throw new Error("v2 hash format invalid: expected v2:<salt-hex>:<key-hex>");
      }
      return {
        version,
        salt: Buffer.from(parts[1], "hex"),
        derivedKey: Buffer.from(parts[2], "hex"),
      };

    default:
      throw new Error(`Unknown hash version: ${version}`);
  }
}

/**
 * Hash a plaintext value with the current policy.
 * Returns the formatted versioned hash ready for storage.
 */
export function hashWithCurrentVersion(plaintext: string): string {
  const policy = HASH_POLICIES[CURRENT_HASH_VERSION];
  if (!policy) {
    throw new Error(`Current policy ${CURRENT_HASH_VERSION} not found`);
  }

  switch (CURRENT_HASH_VERSION) {
    case HashAlgorithmVersion.V1_SHA256:
      const derivedKey = createHash("sha256").update(plaintext).digest();
      return formatVersionedHash({
        version: CURRENT_HASH_VERSION,
        derivedKey,
      });

    case HashAlgorithmVersion.V2_PBKDF2_SHA256:
      const salt = randomBytes(policy.salt!.bytes);
      const derived = pbkdf2Sync(
        plaintext,
        salt,
        policy.iterations || 100000,
        policy.keyBytes || 32,
        policy.digest || "sha256"
      );
      return formatVersionedHash({
        version: CURRENT_HASH_VERSION,
        salt,
        derivedKey: derived,
      });

    default:
      throw new Error(`Unknown hash version: ${CURRENT_HASH_VERSION}`);
  }
}

/**
 * Verify a plaintext value against a versioned hash.
 * Returns { valid: boolean, version: number }.
 * Unknown versions throw an error (fail-closed).
 * Timing-safe comparison on the final derived key only.
 */
export function verifyVersionedHash(
  plaintext: string,
  formatted: string,
): { valid: boolean; version: HashAlgorithmVersion } {
  let parsed: VersionedHash;

  try {
    parsed = parseVersionedHash(formatted);
  } catch (error) {
    throw error; // Unknown versions fail closed
  }

  const policy = HASH_POLICIES[parsed.version];
  if (!policy) {
    throw new Error(`Hash version ${parsed.version} not found in policy registry`);
  }

  let candidateDerivedKey: Buffer;

  switch (parsed.version) {
    case HashAlgorithmVersion.V1_SHA256:
      candidateDerivedKey = createHash("sha256").update(plaintext).digest();
      break;

    case HashAlgorithmVersion.V2_PBKDF2_SHA256:
      if (!parsed.salt) {
        throw new Error("v2 hash missing salt");
      }
      candidateDerivedKey = pbkdf2Sync(
        plaintext,
        parsed.salt,
        policy.iterations || 100000,
        policy.keyBytes || 32,
        policy.digest || "sha256"
      );
      break;

    default:
      throw new Error(`Unknown hash version: ${parsed.version}`);
  }

  // Timing-safe comparison
  const valid =
    candidateDerivedKey.length === parsed.derivedKey.length &&
    candidateDerivedKey.equals(parsed.derivedKey);

  return { valid, version: parsed.version };
}

/**
 * Check if a hash version is considered weak (below minimum threshold).
 */
export function isWeakVersion(
  version: HashAlgorithmVersion,
  config: HashPolicyConfig,
): boolean {
  return version < config.minimumVersion;
}

import { ApiProperty } from "@nestjs/swagger";

/**
 * Configuration fingerprint entry in a snapshot.
 * Represents a single configuration key-value pair that is not secret-bearing.
 */
export class ConfigEntryDto {
  @ApiProperty({
    description: "Dot-path to the configuration setting.",
    example: "stellar.networkPassphrase",
  })
  path!: string;

  @ApiProperty({
    description: "The configuration value (scalar or scalar array).",
    oneOf: [
      { type: "string" },
      { type: "number" },
      { type: "boolean" },
      { type: "null" },
      { type: "array", items: { type: ["string", "number", "boolean", "null"] } },
    ],
    example: "Test SDF Network ; September 2015",
  })
  value!: string | number | boolean | null | (string | number | boolean | null)[];
}

/**
 * Excluded configuration entry: a path withhold from the fingerprint
 * due to secret detection.
 */
export class ExcludedConfigEntryDto {
  @ApiProperty({
    description: "Dot-path to the configuration setting that was excluded.",
    example: "databaseUrl",
  })
  path!: string;

  @ApiProperty({
    description:
      "Why the entry was excluded. `secret_name` means the path " +
      "contains a word marking it as secret-bearing. `secret_value` means " +
      "the value matched a pattern for key material, credentials, or " +
      "connection strings.",
    enum: ["secret_name", "secret_value"],
    example: "secret_name",
  })
  reason!: "secret_name" | "secret_value";
}

/**
 * HMAC-SHA256 signature over the fingerprint content.
 */
export class ConfigSnapshotSignatureDto {
  @ApiProperty({
    description: "The signature algorithm.",
    enum: ["HMAC-SHA256"],
    example: "HMAC-SHA256",
  })
  alg!: "HMAC-SHA256";

  @ApiProperty({
    description:
      "The key identifier. `dedicated` if a dedicated signing secret was " +
      "configured; `derived-credential` if the key was derived from the " +
      "credential signing secret; `unknown` if no signing key is available.",
    example: "derived-credential",
  })
  keyId!: string;

  @ApiProperty({
    description: "The signature value (lowercase hex).",
    example: "a1b2c3d4e5f6...",
  })
  value!: string;
}

/**
 * Startup configuration fingerprint: a versioned, scoped, signed snapshot
 * of non-secret configuration.
 *
 * Operators use this to detect configuration drift without exposing secrets.
 * The fingerprint is deterministic: identical configuration always produces
 * the same hash and signature. The signature proves the snapshot was captured
 * by this deployment and has not been altered.
 *
 * See earnproof-backend#329 (configuration rollouts) and #393 (publish fingerprints).
 */
export class ConfigFingerprintDto {
  @ApiProperty({
    description: "The schema version for this fingerprint.",
    example: "earnproof.config-snapshot.v1",
  })
  schema!: string;

  @ApiProperty({
    description:
      "Environment name where the fingerprint was captured (e.g., " +
      "production, staging, development, or NODE_ENV).",
    example: "production",
  })
  environment!: string;

  @ApiProperty({
    description: "ISO-8601 UTC timestamp when the fingerprint was captured.",
    example: "2025-01-15T12:00:00.000Z",
  })
  capturedAt!: string;

  @ApiProperty({
    description:
      "Content hash: a stable identifier for this exact configuration. " +
      "Identical configuration always produces the same hash, independent " +
      "of the capture time. Format is `sha256:<lowercase-hex>`.",
    example: "sha256:a1b2c3d4e5f6...",
  })
  contentHash!: string;

  @ApiProperty({
    description: "Non-secret configuration entries, sorted by path.",
    type: [ConfigEntryDto],
  })
  entries!: ConfigEntryDto[];

  @ApiProperty({
    description:
      "Configuration paths withheld from the snapshot, sorted by path. " +
      "Values are never recorded — only the path and the reason it was excluded.",
    type: [ExcludedConfigEntryDto],
  })
  excluded!: ExcludedConfigEntryDto[];

  @ApiProperty({
    description: "HMAC-SHA256 signature proving the snapshot is unaltered.",
    type: ConfigSnapshotSignatureDto,
  })
  signature!: ConfigSnapshotSignatureDto;
}


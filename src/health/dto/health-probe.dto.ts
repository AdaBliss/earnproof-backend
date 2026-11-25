import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class LivenessResponseDto {
  @ApiProperty({ example: "ok" })
  status!: string;

  @ApiProperty({ example: "earnproof-api" })
  service!: string;

  @ApiProperty({
    description: "ISO-8601 UTC timestamp of when the probe was answered.",
    example: "2025-01-15T12:00:00.000Z",
  })
  timestamp!: string;
}

export class DependencyResultDto {
  @ApiProperty({
    description: "Stable dependency identifier.",
    example: "database",
  })
  name!: string;

  @ApiProperty({
    description:
      "Whether this dependency can make the service unready. Only required " +
      "dependencies gate readiness.",
    enum: ["required", "optional"],
    example: "required",
  })
  kind!: string;

  @ApiProperty({
    description:
      "Stable status code. Callers should branch on this rather than on any " +
      "human-readable text.",
    enum: ["ok", "degraded", "timeout", "error", "disabled", "not_configured"],
    example: "ok",
  })
  status!: string;

  @ApiPropertyOptional({
    description: "Observed probe duration in milliseconds.",
    example: 12,
  })
  durationMs?: number;

  @ApiPropertyOptional({
    description:
      "Stable, non-identifying reason code for a non-ok status. Never contains " +
      "connection strings, credentials, hostnames, or raw driver errors.",
    example: "probe_timeout",
  })
  reason?: string;

  @ApiPropertyOptional({
    description: "True when this result was served from cache.",
    example: false,
  })
  cached?: boolean;

  @ApiPropertyOptional({
    description: "Age of a cached result in milliseconds.",
    example: 1200,
  })
  ageMs?: number;

  @ApiPropertyOptional({
    description:
      "Diagnostics only, on the `clock_skew` entry: provable local-vs-network " +
      "skew (ms, positive = local ahead), sustained-alert state, policy and " +
      "per-source outcome codes. See docs/clock-skew.md.",
    type: "object",
    additionalProperties: true,
  })
  clockSkew?: object;

  @ApiPropertyOptional({
    description:
      "Diagnostics only, on the `database_pool` entry: bounded pool " +
      "occupancy, wait latency, timeout counts, thresholds, hysteresis " +
      "state, and the runbook link. Counts and ratios only — never a " +
      "connection string, credential, host, or query text. See " +
      "docs/runbooks/database-pool-saturation.md.",
    type: "object",
    additionalProperties: true,
  })
  pool?: object;
}

export class ReadinessResponseDto {
  @ApiProperty({
    description:
      "Aggregate verdict. Only required dependencies can produce not_ready. " +
      "Returned only by the authorized diagnostics endpoint; the public " +
      "readiness probe reports just this verdict, never the dependency list.",
    enum: ["ready", "not_ready"],
    example: "ready",
  })
  status!: string;

  @ApiProperty({ type: [DependencyResultDto] })
  dependencies!: DependencyResultDto[];
}

/**
 * Public readiness probe response.
 *
 * Deliberately minimal: the aggregate verdict, the service name, when the
 * probe was answered, and — when the request carried one — the opaque
 * `X-Request-ID` correlation reference. It names no dependency, carries no
 * reason code, duration, or diagnostic detail, so an unauthenticated caller
 * learns only whether the service can serve work and how to ask an operator
 * about this specific answer.
 */
export class PublicReadinessResponseDto {
  @ApiProperty({
    description:
      "Aggregate verdict. Only required dependencies can produce not_ready.",
    enum: ["ready", "not_ready"],
    example: "ready",
  })
  status!: string;

  @ApiProperty({ example: "earnproof-api" })
  service!: string;

  @ApiProperty({
    description: "ISO-8601 UTC timestamp of when the probe was answered.",
    example: "2025-01-15T12:00:00.000Z",
  })
  timestamp!: string;

  @ApiPropertyOptional({
    description:
      "Opaque correlation reference echoed from the X-Request-ID header. " +
      "Identifies this request in server-side logs; it is not a dependency " +
      "or diagnostic detail.",
    example: "9f2c1a7b4e5d4a3b8c6d7e8f90a1b2c3",
  })
  requestId?: string;
}

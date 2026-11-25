import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { IssuerKeyCompromiseIncidentState } from "@prisma/client";

/**
 * Shared length cap for operator-supplied compromise reason / resolution
 * notes. Mirrors the quarantine decision-reason cap (1024 chars).
 */
export const KEY_COMPROMISE_NOTE_MAX_LENGTH = 1024;

/**
 * Maximum number of incidents returned by the list endpoint in one page.
 */
export const KEY_COMPROMISE_LIST_MAX_LIMIT = 100;

export class RespondToKeyCompromiseDto {
  @ApiProperty({
    description:
      "Operator-supplied reason for the compromise report. Stored on the incident and in the audit log. Must never contain key material.",
    example:
      "Issuer reported the signing key may have leaked via a compromised build host.",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(KEY_COMPROMISE_NOTE_MAX_LENGTH)
  reason: string;
}

export class ResolveKeyCompromiseIncidentDto {
  @ApiProperty({
    description:
      "How the incident was recovered (for example, replacement key registered and verified, affected credentials re-issued). Stored as recovery evidence on the incident.",
    example:
      "Replacement key key-2 registered, verified against the contract, and all affected credentials re-issued.",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(KEY_COMPROMISE_NOTE_MAX_LENGTH)
  note: string;
}

export class ListKeyCompromiseIncidentsDto {
  @ApiPropertyOptional({
    description: "Filter by incident state.",
    enum: IssuerKeyCompromiseIncidentState,
  })
  @IsOptional()
  @IsEnum(IssuerKeyCompromiseIncidentState)
  state?: IssuerKeyCompromiseIncidentState;

  @ApiPropertyOptional({
    description: "Maximum incidents to return (1-100, default 20).",
    example: 20,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(KEY_COMPROMISE_LIST_MAX_LIMIT)
  limit?: number;
}

export class KeyCompromiseIncidentResponseDto {
  @ApiProperty({ description: "Incident id." })
  id: string;

  @ApiProperty({ description: "Issuer the compromised key belongs to." })
  issuerId: string;

  @ApiProperty({ description: "Public keyId of the compromised signing key." })
  keyId: string;

  @ApiProperty({
    description: "Incident state: OPEN → CONTAINED → RESOLVED.",
    enum: IssuerKeyCompromiseIncidentState,
  })
  state: IssuerKeyCompromiseIncidentState;

  @ApiProperty({
    description: "Operator-supplied reason for the compromise report.",
  })
  reason: string;

  @ApiProperty({
    description: "When the key was marked compromised (ISO 8601).",
  })
  compromisedAt: string;

  @ApiProperty({
    description:
      "Number of ACTIVE trust pins revoked for this key. Revoking them is what makes the compromised key fail verification policy.",
  })
  trustPinsRevoked: number;

  @ApiProperty({
    description:
      "Number of already-quarantined credentials found under this keyId.",
  })
  affectedQuarantines: number;

  @ApiProperty({
    description:
      "Number of proofs whose issuer policy snapshot names this keyId. Counted for operator review; proofs are never auto-revoked by this flow.",
  })
  affectedProofs: number;

  @ApiProperty({
    description:
      "True when any discovery source hit its bounded cap; counts are then lower bounds, not exact totals.",
  })
  discoveryTruncated: boolean;

  @ApiPropertyOptional({
    description:
      "Deterministic evidence fingerprint (sha256:<hex> of the canonical evidence document), set when the incident is contained.",
  })
  evidenceHash?: string | null;

  @ApiPropertyOptional({
    description: "When the incident was contained (ISO 8601).",
  })
  containedAt?: string | null;

  @ApiPropertyOptional({
    description: "When the incident was resolved (ISO 8601).",
  })
  resolvedAt?: string | null;

  @ApiPropertyOptional({
    description: "Resolution note recorded by the resolving operator.",
  })
  resolutionNote?: string | null;

  @ApiPropertyOptional({
    description:
      "Id of the security notification raised for the issuer organization, if one was created.",
  })
  notificationId?: string | null;

  @ApiPropertyOptional({
    description:
      "When the key commitment was last confirmed against the contract. Null when no on-chain sync is on record.",
  })
  contractReconciledAt?: string | null;

  @ApiProperty({ description: "When the incident was created (ISO 8601)." })
  createdAt: string;
}

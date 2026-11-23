import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IssuerAssuranceLevel, ResourceStatus } from "@prisma/client";
import { EffectiveAccreditationStatus } from "../issuer-assurance";

export class IssuerResponseDto {
  @ApiProperty({ description: "Issuer unique ID" })
  id: string;

  @ApiProperty({ description: "Organization ID this issuer belongs to" })
  organizationId: string;

  @ApiProperty({ description: "Stellar public key address" })
  stellarAddress: string;

  @ApiProperty({
    description: "Issuer status (PENDING, ACTIVE, SUSPENDED, REVOKED, DELETED)",
    enum: ["ACTIVE", "PENDING", "SUSPENDED", "REVOKED", "DELETED"],
  })
  status: ResourceStatus;

  @ApiProperty({
    description:
      "Revision number for optimistic concurrency control. Incremented on each update.",
  })
  revision: number;

  @ApiProperty({
    description:
      "Contract-backed assurance level. NONE means no accreditation has been " +
      "observed from the registry contract; it is never set from tenant metadata.",
    enum: ["NONE", "BASIC", "STANDARD", "ENHANCED"],
  })
  assuranceLevel: IssuerAssuranceLevel;

  @ApiPropertyOptional({
    description:
      "ISO 8601 timestamp when the contract-backed accreditation expires; " +
      "null for a perpetual accreditation",
    nullable: true,
  })
  accreditationExpiresAt: Date | null;

  @ApiPropertyOptional({
    description:
      "ISO 8601 timestamp when the contract state behind the assurance fields " +
      "was last observed (provenance)",
    nullable: true,
  })
  accreditationSyncedAt?: Date | null;

  @ApiPropertyOptional({
    description:
      "Registry contract the accreditation was observed from (provenance)",
    nullable: true,
  })
  accreditationContractId?: string | null;

  @ApiPropertyOptional({
    description:
      "Transaction that last established the accreditation on-chain, when the " +
      "observation followed a sync submission",
    nullable: true,
  })
  accreditationTransactionHash?: string | null;

  @ApiProperty({
    description:
      "Effective accreditation status, folding the contract-backed assurance " +
      "level and expiry into the stored status. Computed live, so an expired " +
      "accreditation reads EXPIRED even before the reconciler has run.",
    enum: [
      "ACTIVE",
      "EXPIRED",
      "NOT_ACCREDITED",
      "REVOKED",
      "SUSPENDED",
      "PENDING",
      "DELETED",
    ],
  })
  effectiveAccreditationStatus: EffectiveAccreditationStatus;

  @ApiProperty({
    description:
      "Whether the accreditation projection is stale: true when the issuer " +
      "looks accredited but the contract observation is missing or older " +
      "than the staleness bound. A stale projection cannot assert active " +
      "accreditation.",
  })
  accreditationStale: boolean;

  @ApiPropertyOptional({
    description: "Hash of the public metadata for integrity verification",
    nullable: true,
  })
  metadataHash: string | null;

  @ApiPropertyOptional({
    description: "Allowlisted issuer metadata stored by the API.",
    nullable: true,
  })
  publicMetadata?: Record<string, string> | null;

  @ApiProperty({
    description: "Latest issuer-registry synchronization state.",
    enum: ["PENDING", "SYNCED", "FAILED", "DISABLED"],
  })
  contractSyncState: string;

  @ApiPropertyOptional({ nullable: true })
  contractTransactionHash?: string | null;

  @ApiPropertyOptional({ nullable: true })
  contractSyncedAt?: Date | null;

  @ApiPropertyOptional({
    description: "ISO 8601 timestamp when issuer was verified/activated",
    nullable: true,
  })
  verifiedAt: Date | null;

  @ApiPropertyOptional({
    description: "ISO 8601 timestamp when issuer was suspended",
    nullable: true,
  })
  suspendedAt: Date | null;

  @ApiPropertyOptional({
    description: "ISO 8601 timestamp when issuer was revoked",
    nullable: true,
  })
  revokedAt: Date | null;

  @ApiProperty({ description: "ISO 8601 timestamp when issuer was created" })
  createdAt: Date;

  @ApiProperty({
    description: "ISO 8601 timestamp when issuer was last updated",
  })
  updatedAt: Date;
}

export class IssuerPublicResponseDto {
  @ApiProperty({ description: "Issuer unique ID" })
  id: string;

  @ApiProperty({ description: "Stellar public key address" })
  stellarAddress: string;

  @ApiProperty({
    description:
      "Effective trust status (based on status, suspension, and revocation). " +
      "This is lifecycle trust only; accreditation must be read from " +
      "effectiveAccreditationStatus.",
  })
  trustStatus: "TRUSTED" | "PENDING" | "SUSPENDED" | "REVOKED";

  @ApiProperty({
    description:
      "Contract-backed assurance level. NONE means no accreditation has been " +
      "observed from the registry contract.",
    enum: ["NONE", "BASIC", "STANDARD", "ENHANCED"],
  })
  assuranceLevel: IssuerAssuranceLevel;

  @ApiPropertyOptional({
    description:
      "ISO 8601 timestamp when the contract-backed accreditation expires; " +
      "null for a perpetual accreditation",
    nullable: true,
  })
  accreditationExpiresAt: Date | null;

  @ApiProperty({
    description:
      "Effective accreditation status, folding the contract-backed assurance " +
      "level and expiry into the stored status. Computed live, so an expired " +
      "accreditation reads EXPIRED even before the reconciler has run.",
    enum: [
      "ACTIVE",
      "EXPIRED",
      "NOT_ACCREDITED",
      "REVOKED",
      "SUSPENDED",
      "PENDING",
      "DELETED",
    ],
  })
  effectiveAccreditationStatus: EffectiveAccreditationStatus;

  @ApiProperty({
    description:
      "Whether the accreditation projection is stale: true when the issuer " +
      "looks accredited but the contract observation is missing or older " +
      "than the staleness bound.",
  })
  accreditationStale: boolean;

  @ApiProperty({
    description:
      "Allowlisted public metadata (name, description, logoUrl only)",
  })
  publicMetadata: {
    name?: string;
    description?: string;
    logoUrl?: string;
  };

  @ApiProperty({ description: "ISO 8601 timestamp when issuer was created" })
  createdAt: Date;
}

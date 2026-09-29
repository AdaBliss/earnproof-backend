import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ResourceStatus } from "@prisma/client";

export class OrganizationResponseDto {
  @ApiProperty({ description: "Organization unique ID" })
  id: string;

  @ApiProperty({ description: "Organization display name" })
  name: string;

  @ApiProperty({ description: "Organization URL slug" })
  slug: string;

  @ApiProperty({ description: "Organization website URL", nullable: true })
  website: string | null;

  @ApiProperty({
    description: "Organization status",
    enum: ["ACTIVE", "PENDING", "SUSPENDED", "REVOKED", "DELETED"],
  })
  status: ResourceStatus;

  @ApiProperty({
    description:
      "Revision number for optimistic concurrency control. Incremented on each update.",
  })
  revision: number;

  @ApiProperty({ description: "ID of user who created the organization" })
  createdById: string;

  @ApiProperty({
    description: "ISO 8601 timestamp when organization was created",
  })
  createdAt: Date;

  @ApiProperty({
    description: "ISO 8601 timestamp when organization was last updated",
  })
  updatedAt: Date;

  @ApiPropertyOptional({
    description: "Number of issuers in this organization",
    type: Number,
  })
  issuerCount?: number;
}

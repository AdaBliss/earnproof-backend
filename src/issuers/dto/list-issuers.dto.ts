import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsEnum } from "class-validator";
import { IssuerAssuranceLevel, ResourceStatus } from "@prisma/client";
import { CursorPaginationQueryDto } from "../../common/pagination/pagination.dto";
import { EffectiveAccreditationStatus } from "../issuer-assurance";

/**
 * Filter values for the effective accreditation status. Same strings as
 * {@link EffectiveAccreditationStatus}; kept as a runtime enum so
 * class-validator can reject anything else with a 400.
 */
export enum AccreditationStatusFilter {
  ACTIVE = "ACTIVE",
  EXPIRED = "EXPIRED",
  NOT_ACCREDITED = "NOT_ACCREDITED",
  REVOKED = "REVOKED",
  SUSPENDED = "SUSPENDED",
  PENDING = "PENDING",
  DELETED = "DELETED",
}

export class ListIssuersDto extends CursorPaginationQueryDto {
  @ApiPropertyOptional({
    description: "Filter by issuer status",
    enum: ["ACTIVE", "PENDING", "SUSPENDED", "REVOKED", "DELETED"],
  })
  @IsOptional()
  @IsEnum(ResourceStatus)
  status?: ResourceStatus;

  @ApiPropertyOptional({
    description: "Filter by organization ID",
    example: "cuid123",
  })
  @IsOptional()
  organizationId?: string;

  @ApiPropertyOptional({
    description:
      "Filter by contract-backed assurance level (NONE = no accreditation " +
      "observed from the registry contract)",
    enum: ["NONE", "BASIC", "STANDARD", "ENHANCED"],
  })
  @IsOptional()
  @IsEnum(IssuerAssuranceLevel)
  assuranceLevel?: IssuerAssuranceLevel;

  @ApiPropertyOptional({
    description:
      "Filter by effective accreditation status, computed live from the " +
      "stored status, assurance level, and expiry (same boundary as the " +
      "response field). Combined with `status` under AND, so disagreeing " +
      "values match nothing instead of one silently winning.",
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
  @IsOptional()
  @IsEnum(AccreditationStatusFilter)
  accreditationStatus?: EffectiveAccreditationStatus;
}

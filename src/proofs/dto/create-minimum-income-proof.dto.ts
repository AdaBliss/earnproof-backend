import { IsStellarAmount, STELLAR_AMOUNT_PATTERN } from "../../common/validation/stellar-amount";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { FIELD_LIMITS } from "../../common/limits/request-limits";

export class CreateMinimumIncomeProofDto {
  @ApiProperty({
    description:
      "IDs of the payments to include in the proof. All must be classified as INCOME, " +
      "eligible (asset is on the supported-asset list), belong to the authenticated user, " +
      "use the requested asset, and fall within the requested period.",
    type: [String],
    example: ["clx1abc2def3ghi4", "clx1xyz5uvw6rst7"],
  })
  @IsArray()
  @ArrayMinSize(1)
  // Without a cap, one request can ask the database to load an unbounded number
  // of payments and decrypt every amount. A year of daily payments is 365.
  @ArrayMaxSize(FIELD_LIMITS.paymentIdsPerProof)
  @IsString({ each: true })
  @MaxLength(FIELD_LIMITS.id, { each: true })
  selectedPaymentIds!: string[];

  @ApiProperty({
    description:
      "Minimum income threshold expressed as a decimal string with up to 7 decimal places. " +
      "The sum of selected payment amounts must be greater than or equal to this value.",
    pattern: STELLAR_AMOUNT_PATTERN,
    example: "500.0000000",
  })
  @IsString()
  @MaxLength(FIELD_LIMITS.decimalAmount)
  @IsStellarAmount()
  thresholdAmount!: string;

  @ApiProperty({
    description: "Stellar asset code that all selected payments must share.",
    example: "USDC",
  })
  @IsString()
  @MaxLength(FIELD_LIMITS.assetCode)
  assetCode!: string;

  @ApiPropertyOptional({
    description:
      "Stellar issuer address for the asset. Omit for native XLM. " +
      "All selected payments must share this issuer.",
    example: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGLA1PIC4CEXLRTKHB0EGB",
  })
  @IsOptional()
  @IsString()
  @MaxLength(FIELD_LIMITS.stellarAddress)
  assetIssuer?: string;

  @ApiProperty({
    description:
      "ISO-8601 date string for the start of the income period (inclusive). " +
      "All selected payments must have `occurredAt` >= this value.",
    example: "2025-01-01T00:00:00.000Z",
  })
  @IsDateString()
  periodStart!: string;

  @ApiProperty({
    description:
      "ISO-8601 date string for the end of the income period (inclusive). " +
      "Must be after `periodStart`. All selected payments must have `occurredAt` <= this value.",
    example: "2025-01-31T23:59:59.000Z",
  })
  @IsDateString()
  periodEnd!: string;

  @ApiPropertyOptional({
    description:
      "Number of days until the proof expires. Defaults to 30. " +
      "Must be between 1 and 365.",
    minimum: 1,
    maximum: 365,
    example: 30,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
}

import { IsString, IsNotEmpty, Matches, IsISO8601 } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import {
  COUNTER_STRING_PATTERN,
  IsCounterString,
  MAX_INT64,
} from '../../common/validation/safe-integer';

export class CreateRevocationCheckpointDto {
  @IsString()
  @IsNotEmpty()
  ledger: string;

  @IsString()
  @IsNotEmpty()
  contractIdentity: string;

  @IsString()
  @IsNotEmpty()
  algorithm: string;

  @ApiProperty({
    type: String,
    pattern: COUNTER_STRING_PATTERN,
    example: '9007199254740993',
    description:
      'Checkpoint sequence as a canonical decimal string (0 to 2^63-1). Encoded as a string ' +
      'because values above 2^53-1 cannot be represented in a JSON number without precision loss.',
  })
  @IsString()
  @IsNotEmpty()
  @IsCounterString(MAX_INT64, { message: 'sequence must be a canonical decimal integer string within int64 range' })
  sequence: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[0-9a-f]+$/i, { message: 'root must be a valid hex string' })
  root: string;

  @IsISO8601()
  @IsNotEmpty()
  observedAt: string;
}

export class CreateRevocationCheckpointResponseDto {
  status: 'accepted' | 'quarantined';
  checkpoint: {
    id: string;
    /** Decimal string; may exceed Number.MAX_SAFE_INTEGER. */
    sequence: string;
    root: string;
    observedAt: string;
    acceptedAt: string;
    status: string;
    quarantineReason?: string;
  };
  head: {
    sequence: string;
    root: string;
    observedAt: string;
    acceptedAt: string;
  };
}

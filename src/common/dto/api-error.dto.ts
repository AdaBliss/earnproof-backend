/**
 * Versioned error contract for all EarnProof API error responses.
 *
 * Compatibility note (v1):
 *   - `code` is stable across minor versions. New codes may be added; existing codes
 *     will not be renamed or removed without a major-version bump.
 *   - `message` is human-readable and may change without notice. Clients must not
 *     branch on the message text.
 *   - `violations` is present only on 422 validation errors.
 *   - `requestId` is always present.
 */

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * Machine-readable error codes.
 * These are stable identifiers that clients can rely on for programmatic
 * handling. New values may be added; existing values will not change.
 */
export enum ApiErrorCode {
  // 400 – bad input from the client
  VALIDATION_ERROR = "VALIDATION_ERROR",
  INVALID_INPUT = "INVALID_INPUT",

  // 401 – authentication required or failed
  MISSING_TOKEN = "MISSING_TOKEN",
  INVALID_TOKEN = "INVALID_TOKEN",
  EXPIRED_TOKEN = "EXPIRED_TOKEN",
  INVALID_CREDENTIALS = "INVALID_CREDENTIALS",
  SESSION_EXPIRED = "SESSION_EXPIRED",

  // 403 – authenticated but not allowed
  FORBIDDEN = "FORBIDDEN",

  // 404 – resource does not exist (or is hidden for security)
  NOT_FOUND = "NOT_FOUND",
  PAYMENT_NOT_FOUND = "PAYMENT_NOT_FOUND",

  // 422 - payment cannot be used for the requested proof
  PAYMENT_NOT_ELIGIBLE = "PAYMENT_NOT_ELIGIBLE",
  PAYMENT_EXCLUDED = "PAYMENT_EXCLUDED",

  // 409 – request conflicts with current state
  CONFLICT = "CONFLICT",

  // 413 – the request exceeded a transport or structural limit
  PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE",

  // 429 – rate limiting
  TOO_MANY_REQUESTS = "TOO_MANY_REQUESTS",

  // 503 – a required dependency is unavailable
  DEPENDENCY_UNAVAILABLE = "DEPENDENCY_UNAVAILABLE",

  // 500 – unexpected server-side failures
  INTERNAL_ERROR = "INTERNAL_ERROR",
}

/** A single field-level validation violation. */
export class FieldViolationDto {
  @ApiProperty({
    description: "The name of the field that failed validation.",
    example: "walletAddress",
  })
  field!: string;

  @ApiProperty({
    description:
      "Human-readable description of the constraint that was violated.",
    example: "walletAddress must be exactly 56 characters",
  })
  message!: string;
}

  /**
   * The standard error envelope returned for all non-2xx responses.
   *
   * @example
   * {
   *   "statusCode": 401,
   *   "code": "INVALID_TOKEN",
   *   "message": "Authentication token is invalid.",
   *   "requestId": "01hwzxyz..."
   * }
   */
  export class ApiErrorDto {
    @ApiProperty({
      description: "HTTP status code.",
      example: 401,
    })
    statusCode!: number;

    @ApiProperty({
      description:
        "Stable machine-readable error code. Clients should branch on this, not on `message`.",
      enum: ApiErrorCode,
      example: ApiErrorCode.INVALID_TOKEN,
    })
    code!: ApiErrorCode;

    @ApiProperty({
      description:
        "Human-readable error description. May change across releases; do not parse.",
      example: "Authentication token is invalid.",
    })
    message!: string;

    @ApiProperty({
      description:
        "Unique identifier for this request. Include this in bug reports and support tickets.",
      example: "01hwzxyz1234abcd",
    })
    requestId!: string;

    @ApiPropertyOptional({
      description:
        "Present only on 422 validation errors. Lists each field that failed.",
      type: [FieldViolationDto],
    })
    violations?: FieldViolationDto[];

    @ApiPropertyOptional({
      description:
        "Present only on 409 conflict errors. Current revision of the resource.",
      example: 5,
    })
    currentRevision?: number;
  }

import { ValidationOptions, registerDecorator } from "class-validator";

/**
 * Safe conversion rules for large integer counters.
 *
 * Ledger numbers, paging cursors, checkpoint and audit sequences can exceed
 * `Number.MAX_SAFE_INTEGER` (2^53 - 1). Converting them through `Number()`
 * silently rounds, which can make two distinct counters compare equal. The rules:
 *
 * - Counters travel as canonical unsigned decimal strings (`"9007199254740993"`)
 *   across API, audit, pagination and contract interfaces, and are held as
 *   `bigint` internally.
 * - Converting to a JS `number` is only permitted when the value is a safe
 *   integer, and otherwise fails explicitly instead of rounding.
 * - Parsing accepts only canonical decimal digits: no sign, exponent, hex,
 *   whitespace, separators or leading zeros.
 */

/** Largest unsigned 64-bit value, the ceiling for Stellar/Soroban counters. */
export const MAX_UINT64 = BigInt("18446744073709551615");

export type UnsafeIntegerReason =
  | "malformed"
  | "out_of_range"
  | "unsafe_conversion";

/** Raised when an integer cannot be represented without precision loss. */
export class UnsafeIntegerError extends Error {
  constructor(readonly reason: UnsafeIntegerReason) {
    super(`Unsafe integer: ${reason}`);
    this.name = "UnsafeIntegerError";
  }
}

const CANONICAL_UINT = /^(0|[1-9][0-9]*)$/;

/**
 * Parses a canonical unsigned decimal string (or a safe non-negative integer
 * number) into a bigint no larger than `max` (default: uint64 maximum).
 */
export function parseCounter(value: unknown, max: bigint = MAX_UINT64): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number") {
    // A number that is not a safe integer has already lost precision.
    if (!Number.isSafeInteger(value)) throw new UnsafeIntegerError("unsafe_conversion");
    parsed = BigInt(value);
  } else if (typeof value === "string" && CANONICAL_UINT.test(value)) {
    parsed = BigInt(value);
  } else {
    throw new UnsafeIntegerError("malformed");
  }

  if (parsed < BigInt(0) || parsed > max) throw new UnsafeIntegerError("out_of_range");
  return parsed;
}

/** Like {@link parseCounter}, but returns `null` instead of throwing. */
export function tryParseCounter(value: unknown, max: bigint = MAX_UINT64): bigint | null {
  try {
    return parseCounter(value, max);
  } catch {
    return null;
  }
}

/** Converts to a JS number only if that is lossless; otherwise throws. */
export function toSafeNumber(value: bigint | string | number): number {
  const counter = parseCounter(value);
  if (counter > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new UnsafeIntegerError("unsafe_conversion");
  }
  return Number(counter);
}

/** Serializes a counter as its canonical decimal string. */
export function serializeCounter(value: bigint | string | number): string {
  return parseCounter(value).toString();
}

/** Pattern (source) for DTO/OpenAPI metadata describing a string-encoded counter. */
export const COUNTER_STRING_PATTERN = "^(0|[1-9]\\d{0,19})$";

/** Largest signed 64-bit value: the ceiling for counters stored in a BigInt column. */
export const MAX_INT64 = BigInt("9223372036854775807");

/** class-validator decorator: field must be a canonical decimal string counter. */
export function IsCounterString(max: bigint = MAX_UINT64, options?: ValidationOptions) {
  return (target: object, propertyName: string) => {
    registerDecorator({
      name: "isCounterString",
      target: target.constructor,
      propertyName,
      options: {
        message: "$property must be a canonical unsigned decimal integer string within range",
        ...options,
      },
      validator: {
        validate: (value: unknown) =>
          typeof value === "string" && tryParseCounter(value, max) !== null,
      },
    });
  };
}

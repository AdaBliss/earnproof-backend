import { ValidationOptions, registerDecorator } from "class-validator";

/**
 * The single canonical parser and formatter for Stellar decimal amounts.
 *
 * Amounts cross string, database, and API boundaries. Every one of them must be
 * decided by this module so that payment ingestion, proof evaluation and
 * response serialization can never disagree about what a value means.
 *
 * Input grammar (nothing else is accepted):
 *
 *   amount := whole [ "." fraction ]
 *   whole  := "0" | [1-9][0-9]*          (no leading zeros, no sign)
 *   fraction := 1 to 7 ASCII digits
 *
 * Consequently these are rejected rather than normalised: exponent notation
 * (`1e3`), signs including negative zero (`-0`, `+1`), more than seven
 * fractional digits, locale separators (`1,5`, `1 000`), hex, whitespace,
 * `NaN`/`Infinity`, and a bare or trailing point (`.5`, `5.`). The value must
 * also fit a signed 64-bit stroop count, which is the Stellar ledger limit.
 *
 * The canonical representation is exactly seven fractional digits
 * (`"5"`, `"5.0"` and `"5.0000000"` all canonicalize to `"5.0000000"`).
 */

/** Number of fractional digits in a Stellar amount. */
export const STELLAR_AMOUNT_SCALE = 7;

/** Stroops in one whole unit of an asset. */
export const STROOPS_PER_UNIT = BigInt(10_000_000);

/** Largest representable amount: the signed 64-bit maximum, in stroops. */
export const MAX_STELLAR_STROOPS = BigInt("9223372036854775807");

/** Regular expression source for DTO/OpenAPI `pattern` metadata. */
export const STELLAR_AMOUNT_PATTERN = "^(0|[1-9]\\d*)(\\.\\d{1,7})?$";

const AMOUNT_GRAMMAR = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,7}))?$/;

export type StellarAmountErrorCode =
  | "malformed"
  | "excess_precision"
  | "out_of_range";

/** Raised for any non-canonical or out-of-range amount. Never echoes the input. */
export class StellarAmountError extends Error {
  constructor(readonly code: StellarAmountErrorCode) {
    super(`Invalid Stellar amount: ${code}`);
    this.name = "StellarAmountError";
  }
}

/** Parses an amount into stroops, or throws {@link StellarAmountError}. */
export function parseStellarAmount(value: unknown): bigint {
  if (typeof value !== "string") throw new StellarAmountError("malformed");

  const match = AMOUNT_GRAMMAR.exec(value);
  if (!match) {
    // Distinguish excess scale from other malformed input so callers can give a
    // precise, input-free reason code.
    if (/^(0|[1-9][0-9]*)\.[0-9]{8,}$/.test(value)) {
      throw new StellarAmountError("excess_precision");
    }
    throw new StellarAmountError("malformed");
  }

  const stroops =
    BigInt(match[1]) * STROOPS_PER_UNIT +
    BigInt((match[2] ?? "").padEnd(STELLAR_AMOUNT_SCALE, "0"));

  if (stroops > MAX_STELLAR_STROOPS) throw new StellarAmountError("out_of_range");
  return stroops;
}

/** Like {@link parseStellarAmount}, but returns `null` instead of throwing. */
export function tryParseStellarAmount(value: unknown): bigint | null {
  try {
    return parseStellarAmount(value);
  } catch {
    return null;
  }
}

/** True when `value` is an acceptable Stellar amount string. */
export function isStellarAmount(value: unknown): value is string {
  return tryParseStellarAmount(value) !== null;
}

/** Formats a stroop count as the canonical seven-decimal amount string. */
export function formatStellarAmount(stroops: bigint): string {
  if (typeof stroops !== "bigint" || stroops < BigInt(0) || stroops > MAX_STELLAR_STROOPS) {
    throw new StellarAmountError("out_of_range");
  }
  const whole = stroops / STROOPS_PER_UNIT;
  const fraction = (stroops % STROOPS_PER_UNIT)
    .toString()
    .padStart(STELLAR_AMOUNT_SCALE, "0");
  return `${whole.toString()}.${fraction}`;
}

/** Parses then formats: the one canonical representation of an amount. */
export function canonicalizeStellarAmount(value: unknown): string {
  return formatStellarAmount(parseStellarAmount(value));
}

/** class-validator decorator that applies the canonical parser to a DTO field. */
export function IsStellarAmount(options?: ValidationOptions) {
  return (target: object, propertyName: string) => {
    registerDecorator({
      name: "isStellarAmount",
      target: target.constructor,
      propertyName,
      options: {
        message:
          "$property must be a decimal amount with at most 7 fractional digits, " +
          "no sign, exponent, or separators",
        ...options,
      },
      validator: {
        validate: (value: unknown) => isStellarAmount(value),
      },
    });
  };
}

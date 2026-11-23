import {
  MAX_INT64,
  MAX_UINT64,
  UnsafeIntegerError,
  parseCounter,
  serializeCounter,
  toSafeNumber,
  tryParseCounter,
} from "./safe-integer";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

describe("safe integer conversion", () => {
  describe("toSafeNumber", () => {
    it("converts values up to MAX_SAFE_INTEGER", () => {
      expect(toSafeNumber(BigInt(MAX_SAFE))).toBe(MAX_SAFE);
      expect(toSafeNumber("9007199254740991")).toBe(MAX_SAFE);
      expect(toSafeNumber(0)).toBe(0);
    });

    it("fails explicitly one past MAX_SAFE_INTEGER instead of rounding", () => {
      expect(() => toSafeNumber(BigInt(MAX_SAFE) + BigInt(1))).toThrow(
        expect.objectContaining({ reason: "unsafe_conversion" }),
      );
      expect(() => toSafeNumber("9007199254740993")).toThrow(UnsafeIntegerError);
    });

    it("refuses a number that has already lost precision", () => {
      expect(() => toSafeNumber(2 ** 53)).toThrow(UnsafeIntegerError);
    });
  });

  describe("parseCounter", () => {
    it("round-trips large counters without precision loss", () => {
      for (const text of ["9007199254740993", "18446744073709551615", "9223372036854775807"]) {
        expect(serializeCounter(parseCounter(text))).toBe(text);
      }
    });

    it("keeps adjacent large counters distinct", () => {
      expect(parseCounter("9007199254740993")).not.toBe(parseCounter("9007199254740992"));
      // The lossy path would have made them equal:
      expect(Number("9007199254740993")).toBe(Number("9007199254740992"));
    });

    it.each(["", "-1", "+1", "1.0", "1e3", "0x10", " 1", "1 ", "007", "NaN", "1,000", "١"])(
      "rejects malformed value %p",
      (value) => {
        expect(() => parseCounter(value)).toThrow(
          expect.objectContaining({ reason: "malformed" }),
        );
        expect(tryParseCounter(value)).toBeNull();
      },
    );

    it.each([null, undefined, {}, [], true])("rejects non-numeric input %p", (value) => {
      expect(() => parseCounter(value)).toThrow(UnsafeIntegerError);
    });

    it("rejects negative bigint and values above the ceiling", () => {
      expect(() => parseCounter(BigInt(-1))).toThrow(
        expect.objectContaining({ reason: "out_of_range" }),
      );
      expect(() => parseCounter((MAX_UINT64 + BigInt(1)).toString())).toThrow(
        expect.objectContaining({ reason: "out_of_range" }),
      );
      expect(() => parseCounter("9223372036854775808", MAX_INT64)).toThrow(
        expect.objectContaining({ reason: "out_of_range" }),
      );
    });

    it("rejects NaN, Infinity and non-integers given as numbers", () => {
      for (const value of [NaN, Infinity, -Infinity, 1.5, -1]) {
        expect(tryParseCounter(value)).toBeNull();
      }
    });
  });
});

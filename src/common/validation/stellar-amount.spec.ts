import {
  MAX_STELLAR_STROOPS,
  StellarAmountError,
  canonicalizeStellarAmount,
  formatStellarAmount,
  isStellarAmount,
  parseStellarAmount,
  tryParseStellarAmount,
} from "./stellar-amount";

describe("canonical Stellar amount parser", () => {
  it.each([
    ["0", BigInt(0)],
    ["0.0000001", BigInt(1)],
    ["1", BigInt(10_000_000)],
    ["1.5", BigInt(15_000_000)],
    ["1.5000000", BigInt(15_000_000)],
    ["500.0000000", BigInt(5_000_000_000)],
    ["922337203685.4775807", MAX_STELLAR_STROOPS],
  ])("parses %s", (value, stroops) => {
    expect(parseStellarAmount(value)).toBe(stroops);
  });

  it("gives equivalent amounts one canonical representation", () => {
    for (const value of ["5", "5.0", "5.00", "5.0000000"]) {
      expect(canonicalizeStellarAmount(value)).toBe("5.0000000");
    }
    expect(canonicalizeStellarAmount("0.1")).toBe("0.1000000");
  });

  it.each([
    ["exponent notation", "1e3"],
    ["uppercase exponent", "1E-7"],
    ["negative zero", "-0"],
    ["negative zero decimal", "-0.0000000"],
    ["negative value", "-1"],
    ["explicit plus sign", "+1"],
    ["comma decimal separator", "1,5"],
    ["thousands separator", "1,000.50"],
    ["space group separator", "1 000"],
    ["arabic-indic digits", "١٢"],
    ["leading zeros", "007"],
    ["leading zero decimal", "00.5"],
    ["leading point", ".5"],
    ["trailing point", "5."],
    ["hexadecimal", "0x10"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["empty string", ""],
    ["leading whitespace", " 1"],
    ["trailing whitespace", "1 "],
    ["trailing newline", "1\n"],
  ])("rejects %s", (_label, value) => {
    expect(() => parseStellarAmount(value)).toThrow(StellarAmountError);
    expect(isStellarAmount(value)).toBe(false);
    expect(tryParseStellarAmount(value)).toBeNull();
  });

  it("rejects excess precision with a precise reason code", () => {
    expect(() => parseStellarAmount("1.00000001")).toThrow(
      expect.objectContaining({ code: "excess_precision" }),
    );
  });

  it("rejects values above the int64 stroop ceiling", () => {
    expect(() => parseStellarAmount("922337203685.4775808")).toThrow(
      expect.objectContaining({ code: "out_of_range" }),
    );
    expect(() => parseStellarAmount("9999999999999999999.9999999")).toThrow(
      expect.objectContaining({ code: "out_of_range" }),
    );
  });

  it.each([1, null, undefined, {}, [], true, BigInt(1)])(
    "rejects non-string input %p",
    (value) => {
      expect(() => parseStellarAmount(value)).toThrow(StellarAmountError);
    },
  );

  it("never echoes the offending input in its message", () => {
    expect.assertions(1);
    try {
      parseStellarAmount("secret-1.234");
    } catch (error) {
      expect((error as Error).message).not.toContain("secret");
    }
  });

  describe("formatStellarAmount", () => {
    it("round-trips through the parser", () => {
      for (const stroops of [BigInt(0), BigInt(1), BigInt(12_345_678), MAX_STELLAR_STROOPS]) {
        expect(parseStellarAmount(formatStellarAmount(stroops))).toBe(stroops);
      }
    });

    it("always emits seven fractional digits", () => {
      expect(formatStellarAmount(BigInt(1))).toBe("0.0000001");
      expect(formatStellarAmount(BigInt(10_000_000))).toBe("1.0000000");
    });

    it("refuses negative and out-of-range stroops", () => {
      expect(() => formatStellarAmount(BigInt(-1))).toThrow(StellarAmountError);
      expect(() => formatStellarAmount(MAX_STELLAR_STROOPS + BigInt(1))).toThrow(
        StellarAmountError,
      );
    });
  });
});

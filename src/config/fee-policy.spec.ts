import {
  DEFAULT_FEE_POLICY,
  FeePolicy,
  assertValidFeePolicy,
  decideFee,
  validateFeePolicy,
} from "./fee-policy";
import { validateEnv } from "./env.validation";

const NOW = new Date("2026-12-01T00:00:00.000Z");
const policy: FeePolicy = {
  baseFeeStroops: 100,
  maxFeeStroops: 5_000,
  surgeThresholdStroops: 1_000,
  surgeMultiplier: 2,
  refusalThresholdStroops: 20_000,
  estimateMaxAgeMs: 60_000,
};
const fresh = (feeStroops: number) => ({
  feeStroops,
  observedAt: new Date(NOW.getTime() - 1_000),
});

describe("decideFee", () => {
  it("uses the network estimate when it is normal", () => {
    expect(decideFee(policy, fresh(400), NOW)).toEqual({
      action: "submit",
      feeStroops: 400,
      reason: "normal",
    });
  });

  it("never pays less than the base fee", () => {
    expect(decideFee(policy, fresh(10), NOW)).toMatchObject({ feeStroops: 100, reason: "normal" });
  });

  it("applies the surge multiplier when the estimate exceeds the surge threshold", () => {
    expect(decideFee(policy, fresh(1_500), NOW)).toEqual({
      action: "submit",
      feeStroops: 3_000,
      reason: "surge",
    });
  });

  it("caps a surge at the ceiling and says so", () => {
    expect(decideFee(policy, fresh(4_000), NOW)).toEqual({
      action: "submit",
      feeStroops: 5_000,
      reason: "surge_capped",
    });
  });

  it("refuses at and above the refusal threshold", () => {
    expect(decideFee(policy, fresh(20_000), NOW)).toEqual({
      action: "refuse",
      reason: "refused_over_threshold",
    });
    expect(decideFee(policy, fresh(10_000_000), NOW).action).toBe("refuse");
  });

  it("treats the surge threshold itself as normal and one above as surge", () => {
    expect(decideFee(policy, fresh(1_000), NOW)).toMatchObject({ reason: "normal" });
    expect(decideFee(policy, fresh(1_001), NOW)).toMatchObject({ reason: "surge" });
  });

  it("falls back to the base fee with a visible reason for a stale estimate", () => {
    const stale = { feeStroops: 4_000, observedAt: new Date(NOW.getTime() - 61_000) };
    expect(decideFee(policy, stale, NOW)).toEqual({
      action: "submit",
      feeStroops: 100,
      reason: "estimate_stale",
    });
  });

  it("accepts an estimate exactly at the staleness bound", () => {
    const edge = { feeStroops: 400, observedAt: new Date(NOW.getTime() - 60_000) };
    expect(decideFee(policy, edge, NOW)).toMatchObject({ reason: "normal" });
  });

  it("falls back to the base fee when there is no estimate", () => {
    expect(decideFee(policy, null, NOW)).toMatchObject({
      feeStroops: 100,
      reason: "estimate_unavailable",
    });
    expect(decideFee(policy, { feeStroops: NaN, observedAt: NOW }, NOW)).toMatchObject({
      reason: "estimate_unavailable",
    });
  });

  it("never exceeds the ceiling for any estimate", () => {
    for (const fee of [0, 1, 99, 100, 999, 1_000, 1_001, 2_499, 2_500, 4_999, 5_000, 19_999]) {
      const decision = decideFee(policy, fresh(fee), NOW);
      if (decision.action === "submit") {
        expect(decision.feeStroops).toBeLessThanOrEqual(policy.maxFeeStroops);
        expect(decision.feeStroops).toBeGreaterThanOrEqual(policy.baseFeeStroops);
      }
    }
  });

  it("exposes only safe reason codes, never amounts or keys", () => {
    expect(JSON.stringify(decideFee(policy, fresh(20_000), NOW))).toBe(
      '{"action":"refuse","reason":"refused_over_threshold"}',
    );
  });
});

describe("fee policy validation", () => {
  it("accepts the defaults", () => {
    expect(validateFeePolicy(DEFAULT_FEE_POLICY)).toEqual([]);
  });

  it.each([
    ["base below protocol minimum", { baseFeeStroops: 99 }],
    ["base above ceiling", { baseFeeStroops: 6_000 }],
    ["non-integer fee", { maxFeeStroops: 1.5 }],
    ["NaN ceiling", { maxFeeStroops: NaN }],
    ["surge threshold below base", { surgeThresholdStroops: 50 }],
    ["refusal not above surge", { refusalThresholdStroops: 1_000 }],
    ["multiplier below one", { surgeMultiplier: 0.5 }],
    ["multiplier too large", { surgeMultiplier: 11 }],
    ["zero staleness window", { estimateMaxAgeMs: 0 }],
    ["fee above uint32", { maxFeeStroops: 4_294_967_296 }],
  ])("rejects %s", (_label, override) => {
    const invalid = { ...policy, ...override };
    expect(validateFeePolicy(invalid).length).toBeGreaterThan(0);
    expect(() => assertValidFeePolicy(invalid)).toThrow(/Invalid fee policy/);
  });
});

describe("fee policy environment validation", () => {
  const minimal = (): Record<string, unknown> => ({ ...baseEnv() });

  it("fails startup on an invalid fee configuration", () => {
    expect(() =>
      validateEnv({
        ...minimal(),
        CONTRACT_FEE_BASE_STROOPS: "5000",
        CONTRACT_FEE_MAX_STROOPS: "1000",
      }),
    ).toThrow(/invalid contract fee policy/i);
  });

  it("accepts the documented defaults", () => {
    expect(validateEnv(minimal())).toMatchObject({
      CONTRACT_FEE_BASE_STROOPS: 100,
      CONTRACT_FEE_MAX_STROOPS: 100_000,
    });
  });

  it("fails startup on a non-numeric fee value", () => {
    expect(() => validateEnv({ ...minimal(), CONTRACT_FEE_MAX_STROOPS: "lots" })).toThrow(
      /CONTRACT_FEE_MAX_STROOPS/,
    );
  });
});

function baseEnv(): Record<string, unknown> {
  // Synthetic placeholders only.
  return {
    DATABASE_URL: "postgresql://user:password@localhost:5432/earnproof",
    REDIS_URL: "redis://localhost:6379",
    SESSION_SECRET: "session_secret_123",
    CREDENTIAL_SIGNING_SECRET: "credential_secret_123",
    PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  };
}

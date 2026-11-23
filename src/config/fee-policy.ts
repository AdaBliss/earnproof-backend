/**
 * Transaction fee policy for Stellar and Soroban submissions.
 *
 * Fee selection needs an explicit policy so congestion can neither trigger
 * unbounded fees nor silently underpay. All values are per-transaction fees in
 * stroops (1 stroop = 0.0000001 XLM), matching the Stellar CLI `--fee` flag.
 *
 * - `baseFeeStroops`        fee used when the network is quiet or no fresh estimate exists.
 * - `surgeThresholdStroops` a network estimate above this is treated as a surge.
 * - `surgeMultiplier`       headroom applied to the estimate while surging.
 * - `maxFeeStroops`         hard ceiling: no decision ever exceeds it.
 * - `refusalThresholdStroops` an estimate at or above this refuses submission outright.
 * - `estimateMaxAgeMs`      older estimates are stale and are not trusted.
 */
export interface FeePolicy {
  baseFeeStroops: number;
  maxFeeStroops: number;
  surgeThresholdStroops: number;
  surgeMultiplier: number;
  refusalThresholdStroops: number;
  estimateMaxAgeMs: number;
}

/** A network fee estimate and when it was observed. */
export interface FeeEstimate {
  feeStroops: number;
  observedAt: Date;
}

/** Stable, safe reason codes: they never contain amounts, keys or addresses. */
export type FeeDecisionReason =
  | "normal"
  | "surge"
  | "surge_capped"
  | "ceiling_applied"
  | "estimate_unavailable"
  | "estimate_stale"
  | "refused_over_threshold";

export type FeeDecision =
  | { action: "submit"; feeStroops: number; reason: FeeDecisionReason }
  | { action: "refuse"; reason: "refused_over_threshold" };

/** The protocol minimum base fee per operation. */
export const MIN_BASE_FEE_STROOPS = 100;
/** Fees are an unsigned 32-bit integer on the wire. */
export const MAX_FEE_STROOPS = 4_294_967_295;
export const MAX_SURGE_MULTIPLIER = 10;

export const DEFAULT_FEE_POLICY: FeePolicy = {
  baseFeeStroops: 100,
  maxFeeStroops: 100_000,
  surgeThresholdStroops: 1_000,
  surgeMultiplier: 2,
  refusalThresholdStroops: 1_000_000,
  estimateMaxAgeMs: 60_000,
};

/**
 * Returns human-readable problems with a policy; empty when it is valid.
 * Called at startup so a bad configuration fails the boot, not a submission.
 */
export function validateFeePolicy(policy: FeePolicy): string[] {
  const errors: string[] = [];
  const integer = (name: string, value: number, min: number, max: number) => {
    if (!Number.isInteger(value) || value < min || value > max) {
      errors.push(`${name} must be an integer between ${min} and ${max}`);
      return false;
    }
    return true;
  };

  const baseOk = integer("baseFeeStroops", policy.baseFeeStroops, MIN_BASE_FEE_STROOPS, MAX_FEE_STROOPS);
  const maxOk = integer("maxFeeStroops", policy.maxFeeStroops, MIN_BASE_FEE_STROOPS, MAX_FEE_STROOPS);
  const surgeOk = integer("surgeThresholdStroops", policy.surgeThresholdStroops, MIN_BASE_FEE_STROOPS, MAX_FEE_STROOPS);
  const refusalOk = integer("refusalThresholdStroops", policy.refusalThresholdStroops, MIN_BASE_FEE_STROOPS, MAX_FEE_STROOPS);
  integer("estimateMaxAgeMs", policy.estimateMaxAgeMs, 1, 24 * 60 * 60 * 1000);

  if (!Number.isFinite(policy.surgeMultiplier) || policy.surgeMultiplier < 1 || policy.surgeMultiplier > MAX_SURGE_MULTIPLIER) {
    errors.push(`surgeMultiplier must be a number between 1 and ${MAX_SURGE_MULTIPLIER}`);
  }
  if (baseOk && maxOk && policy.baseFeeStroops > policy.maxFeeStroops) {
    errors.push("baseFeeStroops must not exceed maxFeeStroops");
  }
  if (baseOk && surgeOk && policy.surgeThresholdStroops < policy.baseFeeStroops) {
    errors.push("surgeThresholdStroops must not be below baseFeeStroops");
  }
  if (surgeOk && refusalOk && policy.refusalThresholdStroops <= policy.surgeThresholdStroops) {
    errors.push("refusalThresholdStroops must exceed surgeThresholdStroops");
  }
  return errors;
}

/** Throws one error listing every problem; for use at startup. */
export function assertValidFeePolicy(policy: FeePolicy): void {
  const errors = validateFeePolicy(policy);
  if (errors.length > 0) {
    throw new Error(`Invalid fee policy: ${errors.join("; ")}`);
  }
}

/**
 * Decides what to pay for one submission. Pure and deterministic, so every
 * decision can be audited and replayed from its inputs.
 *
 * Invariant: a `submit` decision never exceeds `maxFeeStroops`, and never falls
 * below `baseFeeStroops`.
 */
export function decideFee(
  policy: FeePolicy,
  estimate: FeeEstimate | null | undefined,
  now: Date = new Date(),
): FeeDecision {
  const submit = (fee: number, reason: FeeDecisionReason): FeeDecision => ({
    action: "submit",
    feeStroops: Math.min(Math.max(fee, policy.baseFeeStroops), policy.maxFeeStroops),
    reason,
  });

  if (!estimate || !Number.isFinite(estimate.feeStroops) || estimate.feeStroops < 0) {
    return submit(policy.baseFeeStroops, "estimate_unavailable");
  }

  const ageMs = now.getTime() - estimate.observedAt.getTime();
  if (!Number.isFinite(ageMs) || ageMs > policy.estimateMaxAgeMs || ageMs < -policy.estimateMaxAgeMs) {
    // A stale estimate is not trusted in either direction; the reason code makes
    // the fallback visible rather than a silent underpayment.
    return submit(policy.baseFeeStroops, "estimate_stale");
  }

  if (estimate.feeStroops >= policy.refusalThresholdStroops) {
    return { action: "refuse", reason: "refused_over_threshold" };
  }

  if (estimate.feeStroops > policy.surgeThresholdStroops) {
    const wanted = Math.ceil(estimate.feeStroops * policy.surgeMultiplier);
    return wanted > policy.maxFeeStroops
      ? submit(policy.maxFeeStroops, "surge_capped")
      : submit(wanted, "surge");
  }

  if (estimate.feeStroops > policy.maxFeeStroops) {
    return submit(policy.maxFeeStroops, "ceiling_applied");
  }
  return submit(estimate.feeStroops, "normal");
}

import { FeeEstimate } from "../config/fee-policy";
import { tryParseCounter } from "../common/validation/safe-integer";
import { FetchHorizonTransport, HorizonTransport } from "./horizon-transport";

/** Source of network fee estimates, in stroops per operation. */
export interface FeeEstimator {
  /** Latest estimate, or `null` when none could be obtained. Never throws. */
  getEstimate(now?: Date): Promise<FeeEstimate | null>;
}

/** How long a fetched estimate is reused before Horizon is asked again. */
const REFRESH_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Reads the congestion signal from Horizon's `/fee_stats` (the p90 fee actually
 * charged recently). A failure keeps the previous estimate, which then ages out
 * through the policy's staleness window instead of being trusted forever.
 */
export class HorizonFeeEstimator implements FeeEstimator {
  private last: FeeEstimate | null = null;
  private lastFetchAttemptMs = 0;

  constructor(
    private readonly horizonUrl: string,
    private readonly transport: HorizonTransport = new FetchHorizonTransport(),
  ) {}

  async getEstimate(now: Date = new Date()): Promise<FeeEstimate | null> {
    if (now.getTime() - this.lastFetchAttemptMs < REFRESH_INTERVAL_MS) {
      return this.last;
    }
    this.lastFetchAttemptMs = now.getTime();

    try {
      const response = await this.transport.get({
        url: `${this.horizonUrl.replace(/\/$/, "")}/fee_stats`,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      const fee = parseFeeStats(response.status, response.body);
      if (fee !== null) this.last = { feeStroops: fee, observedAt: now };
    } catch {
      // Keep the previous estimate; the policy decides when it is too old.
    }
    return this.last;
  }
}

/** Extracts the p90 charged fee from a `/fee_stats` body, or `null` if unusable. */
export function parseFeeStats(status: number, body: unknown): number | null {
  if (status !== 200 || !body || typeof body !== "object") return null;
  const charged = (body as { fee_charged?: { p90?: unknown } }).fee_charged;
  const counter = tryParseCounter(charged?.p90);
  if (counter === null || counter > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(counter);
}

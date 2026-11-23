import { HorizonFeeEstimator, parseFeeStats } from "./fee-estimator";
import { HorizonTransport } from "./horizon-transport";

const NOW = new Date("2026-12-01T00:00:00.000Z");

function transport(
  ...responses: Array<{ status: number; body: unknown } | Error>
): HorizonTransport & { get: jest.Mock } {
  const queue = [...responses];
  return {
    get: jest.fn(async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return { status: next?.status ?? 500, body: next?.body, headers: {} };
    }),
  };
}

describe("parseFeeStats", () => {
  it("reads the p90 charged fee", () => {
    expect(parseFeeStats(200, { fee_charged: { p90: "250" } })).toBe(250);
  });

  it.each([
    [500, { fee_charged: { p90: "250" } }],
    [200, null],
    [200, {}],
    [200, { fee_charged: { p90: "1e3" } }],
    [200, { fee_charged: { p90: "-1" } }],
    [200, { fee_charged: { p90: "9007199254740993" } }],
    [200, { fee_charged: { p90: 12.5 } }],
  ])("ignores an unusable response (%p, %p)", (status, body) => {
    expect(parseFeeStats(status, body)).toBeNull();
  });
});

describe("HorizonFeeEstimator", () => {
  it("returns a fresh estimate stamped with the observation time", async () => {
    const estimator = new HorizonFeeEstimator(
      "https://horizon.example/",
      transport({ status: 200, body: { fee_charged: { p90: "300" } } }),
    );
    await expect(estimator.getEstimate(NOW)).resolves.toEqual({
      feeStroops: 300,
      observedAt: NOW,
    });
  });

  it("reuses a recent estimate instead of calling Horizon again", async () => {
    const t = transport({ status: 200, body: { fee_charged: { p90: "300" } } });
    const estimator = new HorizonFeeEstimator("https://horizon.example", t);
    await estimator.getEstimate(NOW);
    await estimator.getEstimate(new Date(NOW.getTime() + 1_000));
    expect(t.get).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous observation time on failure so staleness can be detected", async () => {
    const t = transport(
      { status: 200, body: { fee_charged: { p90: "300" } } },
      new Error("network down"),
    );
    const estimator = new HorizonFeeEstimator("https://horizon.example", t);
    await estimator.getEstimate(NOW);

    const later = new Date(NOW.getTime() + 120_000);
    await expect(estimator.getEstimate(later)).resolves.toEqual({
      feeStroops: 300,
      observedAt: NOW,
    });
  });

  it("returns null when no estimate was ever obtained and never throws", async () => {
    const estimator = new HorizonFeeEstimator(
      "https://horizon.example",
      transport(new Error("network down")),
    );
    await expect(estimator.getEstimate(NOW)).resolves.toBeNull();
  });
});

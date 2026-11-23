import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateIncomeRangeProofDto } from "./create-income-range-proof.dto";
import { CreateInvoiceSettlementProofDto } from "./create-invoice-settlement-proof.dto";
import { CreateMinimumIncomeProofDto } from "./create-minimum-income-proof.dto";
import { CreateRevocationCheckpointDto } from "./create-revocation-checkpoint.dto";

const NON_CANONICAL = [
  "1e3",
  "-0",
  "-1",
  "+1",
  "1,5",
  "1 000",
  "1.00000001",
  "007",
  ".5",
  "5.",
  "NaN",
  "Infinity",
  "922337203685.4775808",
];

async function failingProperties(cls: new () => object, body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(cls, body) as object);
  return errors.map((error) => error.property);
}

describe("canonical amount validation on proof requests", () => {
  const minimumIncome = (thresholdAmount: string) => ({
    selectedPaymentIds: ["payment_1"],
    thresholdAmount,
    assetCode: "USDC",
    periodStart: "2025-01-01T00:00:00.000Z",
    periodEnd: "2025-01-31T23:59:59.000Z",
  });

  it("accepts whole, short-fraction and full-precision amounts", async () => {
    for (const amount of ["500", "500.5", "500.0000000", "0.0000001"]) {
      expect(await failingProperties(CreateMinimumIncomeProofDto, minimumIncome(amount))).not.toContain(
        "thresholdAmount",
      );
    }
  });

  it.each(NON_CANONICAL)("rejects thresholdAmount %p", async (amount) => {
    expect(await failingProperties(CreateMinimumIncomeProofDto, minimumIncome(amount))).toContain(
      "thresholdAmount",
    );
  });

  it.each(NON_CANONICAL)("rejects income range bounds %p", async (amount) => {
    const failing = await failingProperties(CreateIncomeRangeProofDto, {
      selectedPaymentIds: ["payment_1"],
      lowerBound: amount,
      upperBound: amount,
      assetCode: "USDC",
      periodStart: "2025-01-01T00:00:00.000Z",
      periodEnd: "2025-01-31T23:59:59.000Z",
    });
    expect(failing).toEqual(expect.arrayContaining(["lowerBound", "upperBound"]));
  });

  it.each(NON_CANONICAL)("rejects invoice expectedAmount %p", async (amount) => {
    const failing = await failingProperties(CreateInvoiceSettlementProofDto, {
      invoiceReference: "INV-1",
      expectedAmount: amount,
      assetCode: "USDC",
    });
    expect(failing).toContain("expectedAmount");
  });
});

describe("string-encoded large counters on checkpoint requests", () => {
  const checkpoint = (sequence: string) => ({
    ledger: "123",
    contractIdentity: "CONTRACT",
    algorithm: "sha256",
    sequence,
    root: "abcdef",
    observedAt: "2026-01-01T00:00:00.000Z",
  });

  it.each(["0", "1", "9007199254740993", "9223372036854775807"])(
    "accepts sequence %p without precision loss",
    async (sequence) => {
      expect(await failingProperties(CreateRevocationCheckpointDto, checkpoint(sequence))).not.toContain(
        "sequence",
      );
    },
  );

  it.each(["9223372036854775808", "18446744073709551615", "-1", "1e3", "01", "1.0", ""])(
    "rejects sequence %p",
    async (sequence) => {
      expect(await failingProperties(CreateRevocationCheckpointDto, checkpoint(sequence))).toContain(
        "sequence",
      );
    },
  );
});

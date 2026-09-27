import { CreateChallengeDto } from "../../src/auth/dto/create-challenge.dto";
import { VerifyChallengeDto } from "../../src/auth/dto/verify-challenge.dto";
import { CreateEmployerPaymentProofDto } from "../../src/proofs/dto/create-employer-payment-proof.dto";
import { CreatePaymentReceiptProofDto } from "../../src/proofs/dto/create-payment-receipt-proof.dto";
import { CreateMinimumIncomeProofDto } from "../../src/proofs/dto/create-minimum-income-proof.dto";
import {
  CreateRecurringIncomeProofDto,
  INTERVAL_UNITS,
} from "../../src/proofs/dto/create-recurring-income-proof.dto";
import {
  COMMON_UNKNOWN_FIELD,
  isValidDto,
  validateDto,
} from "./dto-contract";

const VALID_WALLET = "G".repeat(56);

// ---------------------------------------------------------------------------
// CreateChallengeDto
// ---------------------------------------------------------------------------

describe("CreateChallengeDto validation contract", () => {
  it("accepts a well-formed 56-char wallet address", async () => {
    expect(
      await isValidDto(CreateChallengeDto, { walletAddress: VALID_WALLET }),
    ).toBe(true);
  });

  it.each([
    ["missing", {}],
    ["empty string", { walletAddress: "" }],
    ["too short", { walletAddress: "G".repeat(55) }],
    ["too long", { walletAddress: "G".repeat(57) }],
    ["wrong type: number", { walletAddress: 12345 }],
    ["wrong type: object", { walletAddress: {} }],
    ["wrong type: array", { walletAddress: ["G".repeat(56)] }],
    ["wrong type: null", { walletAddress: null }],
  ])("rejects walletAddress that is %s", async (_label, plain) => {
    const violations = await validateDto(CreateChallengeDto, plain);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.property === "walletAddress")).toBe(true);
  });

  it("rejects an unknown top-level field (forbidNonWhitelisted)", async () => {
    const violations = await validateDto(CreateChallengeDto, {
      walletAddress: VALID_WALLET,
      ...COMMON_UNKNOWN_FIELD,
    });
    expect(violations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// VerifyChallengeDto
// ---------------------------------------------------------------------------

describe("VerifyChallengeDto validation contract", () => {
  const valid = {
    challengeId: "chal_123",
    walletAddress: VALID_WALLET,
    signature: "deadbeef",
  };

  it("accepts a well-formed request", async () => {
    expect(await isValidDto(VerifyChallengeDto, valid)).toBe(true);
  });

  it.each([
    ["missing challengeId", { ...valid, challengeId: undefined }],
    ["missing walletAddress", { ...valid, walletAddress: undefined }],
    ["missing signature", { ...valid, signature: undefined }],
    ["wrong-length walletAddress", { ...valid, walletAddress: "G".repeat(10) }],
    ["non-string signature", { ...valid, signature: 42 }],
    ["non-string challengeId", { ...valid, challengeId: {} }],
  ])("rejects a request with %s", async (_label, plain) => {
    const violations = await validateDto(VerifyChallengeDto, plain);
    expect(violations.length).toBeGreaterThan(0);
  });

  it("rejects an unknown field alongside otherwise-valid data", async () => {
    const violations = await validateDto(VerifyChallengeDto, {
      ...valid,
      ...COMMON_UNKNOWN_FIELD,
    });
    expect(violations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// CreatePaymentReceiptProofDto
// ---------------------------------------------------------------------------

describe("CreatePaymentReceiptProofDto validation contract", () => {
  const valid = { paymentId: "pay_123" };

  it("accepts the minimal valid request (all optionals omitted)", async () => {
    expect(await isValidDto(CreatePaymentReceiptProofDto, valid)).toBe(true);
  });

  it("accepts every optional field populated at its boundary", async () => {
    expect(
      await isValidDto(CreatePaymentReceiptProofDto, {
        ...valid,
        discloseSender: true,
        discloseAmount: false,
        expiresInDays: 1,
      }),
    ).toBe(true);
    expect(
      await isValidDto(CreatePaymentReceiptProofDto, {
        ...valid,
        expiresInDays: 365,
      }),
    ).toBe(true);
  });

  it.each([
    ["missing paymentId", { paymentId: undefined }],
    ["empty paymentId", { paymentId: "" }],
    ["non-string paymentId", { paymentId: 42 }],
    ["non-boolean discloseSender", { ...valid, discloseSender: "yes" }],
    ["non-boolean discloseAmount", { ...valid, discloseAmount: "no" }],
    ["expiresInDays below minimum (0)", { ...valid, expiresInDays: 0 }],
    ["expiresInDays above maximum (366)", { ...valid, expiresInDays: 366 }],
    ["expiresInDays non-integer", { ...valid, expiresInDays: 1.5 }],
    ["expiresInDays negative", { ...valid, expiresInDays: -1 }],
  ])("rejects a request with %s", async (_label, plain) => {
    const violations = await validateDto(CreatePaymentReceiptProofDto, plain);
    expect(violations.length).toBeGreaterThan(0);
  });

  it("rejects an unknown field", async () => {
    const violations = await validateDto(CreatePaymentReceiptProofDto, {
      ...valid,
      ...COMMON_UNKNOWN_FIELD,
    });
    expect(violations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// CreateMinimumIncomeProofDto
// ---------------------------------------------------------------------------

describe("CreateMinimumIncomeProofDto validation contract", () => {
  const valid = {
    selectedPaymentIds: ["pay_1", "pay_2"],
    thresholdAmount: "500.0000000",
    assetCode: "USDC",
    periodStart: "2025-01-01T00:00:00.000Z",
    periodEnd: "2025-01-31T23:59:59.000Z",
  };

  it("accepts a well-formed request", async () => {
    expect(await isValidDto(CreateMinimumIncomeProofDto, valid)).toBe(true);
  });

  it.each([
    ["empty selectedPaymentIds array", { ...valid, selectedPaymentIds: [] }],
    [
      "selectedPaymentIds with a non-string element",
      { ...valid, selectedPaymentIds: ["pay_1", 42] },
    ],
    ["thresholdAmount with too many decimals", { ...valid, thresholdAmount: "1.12345678" }],
    ["thresholdAmount non-numeric", { ...valid, thresholdAmount: "abc" }],
    ["thresholdAmount negative", { ...valid, thresholdAmount: "-5.0" }],
    ["missing assetCode", { ...valid, assetCode: undefined }],
    ["periodStart not a date string", { ...valid, periodStart: "not-a-date" }],
    ["periodEnd not a date string", { ...valid, periodEnd: "not-a-date" }],
    ["expiresInDays below minimum", { ...valid, expiresInDays: 0 }],
    ["expiresInDays above maximum", { ...valid, expiresInDays: 400 }],
  ])("rejects a request with %s", async (_label, plain) => {
    const violations = await validateDto(CreateMinimumIncomeProofDto, plain);
    expect(violations.length).toBeGreaterThan(0);
  });

  it("accepts a thresholdAmount with the maximum 7 decimal places", async () => {
    expect(
      await isValidDto(CreateMinimumIncomeProofDto, {
        ...valid,
        thresholdAmount: "1.1234567",
      }),
    ).toBe(true);
  });

  it("accepts thresholdAmount with zero decimal places (whole number)", async () => {
    expect(
      await isValidDto(CreateMinimumIncomeProofDto, {
        ...valid,
        thresholdAmount: "500",
      }),
    ).toBe(true);
  });

  it("rejects an unknown field", async () => {
    const violations = await validateDto(CreateMinimumIncomeProofDto, {
      ...valid,
      ...COMMON_UNKNOWN_FIELD,
    });
    expect(violations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// CreateRecurringIncomeProofDto
// ---------------------------------------------------------------------------

describe("CreateRecurringIncomeProofDto validation contract", () => {
  const valid = {
    selectedPaymentIds: ["pay_1", "pay_2"],
    intervalUnit: "month",
    intervalCount: 3,
    assetCode: "USDC",
    periodStart: "2025-01-01T00:00:00.000Z",
    periodEnd: "2025-03-31T23:59:59.000Z",
  };

  it("accepts a well-formed request", async () => {
    expect(await isValidDto(CreateRecurringIncomeProofDto, valid)).toBe(true);
  });

  it.each(INTERVAL_UNITS.map((unit) => [unit] as const))(
    "accepts every documented intervalUnit value: %s",
    async (unit) => {
      expect(
        await isValidDto(CreateRecurringIncomeProofDto, {
          ...valid,
          intervalUnit: unit,
        }),
      ).toBe(true);
    },
  );

  it.each([
    ["intervalUnit outside the enum", { ...valid, intervalUnit: "fortnight" }],
    ["duplicate selectedPaymentIds", { ...valid, selectedPaymentIds: ["pay_1", "pay_1"] }],
    ["empty selectedPaymentIds", { ...valid, selectedPaymentIds: [] }],
    ["intervalCount below minimum (1)", { ...valid, intervalCount: 1 }],
    ["intervalCount above maximum (121)", { ...valid, intervalCount: 121 }],
    ["intervalCount non-integer", { ...valid, intervalCount: 2.5 }],
    ["missing assetCode", { ...valid, assetCode: undefined }],
    ["periodStart not a date string", { ...valid, periodStart: "yesterday" }],
  ])("rejects a request with %s", async (_label, plain) => {
    const violations = await validateDto(CreateRecurringIncomeProofDto, plain);
    expect(violations.length).toBeGreaterThan(0);
  });

  it("accepts intervalCount at both documented boundaries (2 and 120)", async () => {
    expect(
      await isValidDto(CreateRecurringIncomeProofDto, { ...valid, intervalCount: 2 }),
    ).toBe(true);
    expect(
      await isValidDto(CreateRecurringIncomeProofDto, { ...valid, intervalCount: 120 }),
    ).toBe(true);
  });

  it("rejects an unknown field", async () => {
    const violations = await validateDto(CreateRecurringIncomeProofDto, {
      ...valid,
      ...COMMON_UNKNOWN_FIELD,
    });
    expect(violations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// CreateEmployerPaymentProofDto
// ---------------------------------------------------------------------------

describe("CreateEmployerPaymentProofDto validation contract", () => {
  const valid = {
    trustedSourceId: "ts_123",
    assetCode: "USDC",
    periodStart: "2026-08-01T00:00:00.000Z",
    periodEnd: "2026-09-01T00:00:00.000Z",
  };

  it("accepts the minimal valid request (all optionals omitted)", async () => {
    expect(await isValidDto(CreateEmployerPaymentProofDto, valid)).toBe(true);
  });

  it("accepts every optional field populated at its boundary", async () => {
    expect(
      await isValidDto(CreateEmployerPaymentProofDto, {
        ...valid,
        assetIssuer: VALID_WALLET,
        expiresInDays: 365,
      }),
    ).toBe(true);
  });

  it.each([
    ["missing trustedSourceId", { ...valid, trustedSourceId: undefined }],
    ["empty trustedSourceId", { ...valid, trustedSourceId: "" }],
    ["oversized trustedSourceId", { ...valid, trustedSourceId: "x".repeat(65) }],
    ["missing assetCode", { ...valid, assetCode: undefined }],
    ["oversized assetCode", { ...valid, assetCode: "A".repeat(13) }],
    ["oversized assetIssuer", { ...valid, assetIssuer: "G".repeat(57) }],
    ["non-date periodStart", { ...valid, periodStart: "yesterday" }],
    ["missing periodEnd", { ...valid, periodEnd: undefined }],
    ["expiresInDays above maximum (366)", { ...valid, expiresInDays: 366 }],
    ["expiresInDays below minimum (0)", { ...valid, expiresInDays: 0 }],
  ])("rejects a request with %s", async (_label, plain) => {
    const violations = await validateDto(CreateEmployerPaymentProofDto, plain);
    expect(violations.length).toBeGreaterThan(0);
  });

  it.each([
    ["paymentId", { paymentId: "pay_1" }],
    ["operationId", { operationId: "123" }],
    ["memo", { memo: "salary" }],
  ])("rejects a caller-chosen %s (claim selection is server-side)", async (_label, extra) => {
    const violations = await validateDto(CreateEmployerPaymentProofDto, {
      ...valid,
      ...extra,
    });
    expect(violations.length).toBeGreaterThan(0);
  });

  it("rejects an unknown field", async () => {
    const violations = await validateDto(CreateEmployerPaymentProofDto, {
      ...valid,
      ...COMMON_UNKNOWN_FIELD,
    });
    expect(violations.length).toBeGreaterThan(0);
  });
});

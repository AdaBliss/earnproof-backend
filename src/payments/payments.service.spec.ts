import { PaymentClassification, ResourceStatus } from "@prisma/client";
import { PaymentsService } from "./payments.service";

describe("PaymentsService", () => {
  const config = {
    getOrThrow: jest.fn((key: string) => {
      const values: Record<string, string> = {
        paymentEncryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      };
      return values[key];
    }),
  };

  it("syncs incoming payments idempotently", async () => {
    const prisma = {
      supportedAsset: {
        findMany: jest.fn().mockResolvedValue([
          { code: "XLM", issuer: null, network: "stellar-testnet" },
        ]),
      },
      payment: {
        // syncPayments batches the existence check into one findMany ahead
        // of its loop; an empty result means nothing pre-exists, i.e. every
        // incoming payment is a create.
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({ id: "payment_1" }),
      },
    };
    const stellar = {
      fetchIncomingPayments: jest.fn().mockResolvedValue([
        {
          operationId: "op_1",
          stellarTransactionHash: "tx_1",
          sourceAddress: "GA",
          destinationAddress: "GB",
          assetCode: "XLM",
          assetIssuer: null,
          amount: "10",
          occurredAt: new Date("2026-07-13T00:00:00Z"),
        },
      ]),
      fetchTransaction: jest.fn().mockResolvedValue({
        memo_type: "text",
        memo: "Salary June",
      }),
    };
    const service = new PaymentsService(
      prisma as never,
      stellar as never,
      config as never,
    );

    await expect(
      service.syncPayments({ id: "user_1", walletAddress: "GB" }),
    ).resolves.toEqual({
      totalFetched: 1,
      created: 1,
      updated: 0,
      skipped: 0,
      enrichmentErrors: 0,
      conflicts: 0,
    });

    expect(prisma.supportedAsset.findMany).toHaveBeenCalledWith({
      where: { status: ResourceStatus.ACTIVE },
      select: { code: true, issuer: true, network: true },
    });
    expect(prisma.payment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          classification: PaymentClassification.UNKNOWN,
          isEligible: true,
          amountEncrypted: expect.stringMatching(/^enc:v0:/),
          memo: {
            type: "text",
            value: "Salary June",
            truncated: false,
          },
        }),
      }),
    );
  });

  it("deduplicates transaction memo lookups within one sync", async () => {
    const payments = ["op_1", "op_2"].map((operationId) => ({
      operationId,
      stellarTransactionHash: "shared_tx",
      sourceAddress: "GA",
      destinationAddress: "GB",
      assetCode: "XLM",
      assetIssuer: null,
      amount: "10",
      occurredAt: new Date("2026-07-13T00:00:00Z"),
    }));
    const prisma = {
      supportedAsset: { findMany: jest.fn().mockResolvedValue([]) },
      payment: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const stellar = {
      fetchIncomingPayments: jest.fn().mockResolvedValue(payments),
      fetchTransaction: jest
        .fn()
        .mockResolvedValue({ memo_type: "id", memo: "42" }),
    };
    const service = new PaymentsService(
      prisma as never,
      stellar as never,
      config as never,
    );

    const result = await service.syncPayments({
      id: "user_1",
      walletAddress: "GB",
    });

    expect(stellar.fetchTransaction).toHaveBeenCalledTimes(1);
    expect(result.enrichmentErrors).toBe(0);
    expect(prisma.payment.upsert).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a Horizon response error", new Error("Horizon returned 503")],
    ["a network error", new TypeError("fetch failed")],
    ["a missing transaction", null],
  ])("continues syncing after %s", async (_label, transactionResult) => {
    const prisma = {
      supportedAsset: { findMany: jest.fn().mockResolvedValue([]) },
      payment: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const stellar = {
      fetchIncomingPayments: jest.fn().mockResolvedValue([
        {
          operationId: "op_1",
          stellarTransactionHash: "tx_1",
          sourceAddress: "GA",
          destinationAddress: "GB",
          assetCode: "XLM",
          assetIssuer: null,
          amount: "10",
          occurredAt: new Date("2026-07-13T00:00:00Z"),
        },
      ]),
      fetchTransaction:
        transactionResult instanceof Error
          ? jest.fn().mockRejectedValue(transactionResult)
          : jest.fn().mockResolvedValue(transactionResult),
    };
    const service = new PaymentsService(
      prisma as never,
      stellar as never,
      config as never,
    );

    await expect(
      service.syncPayments({ id: "user_1", walletAddress: "GB" }),
    ).resolves.toMatchObject({ created: 1, enrichmentErrors: 1 });
    expect(prisma.payment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ memo: { type: "none" } }),
      }),
    );
  });

  it("updates classification and records an audit log", async () => {
    const prisma = {
      payment: {
        findFirst: jest.fn().mockResolvedValue({
          id: "payment_1",
          classification: PaymentClassification.UNKNOWN,
          assetCode: "XLM",
          assetIssuer: null,
          isEligible: true,
        }),
        update: jest.fn().mockResolvedValue({
          id: "payment_1",
          classification: PaymentClassification.INCOME,
        }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: "audit_1" }),
      },
    };
    const service = new PaymentsService(
      prisma as never,
      {} as never,
      config as never,
    );

    await expect(
      service.updateClassification(
        { id: "user_1" },
        "payment_1",
        PaymentClassification.INCOME,
      ),
    ).resolves.toMatchObject({
      id: "payment_1",
      classification: PaymentClassification.INCOME,
    });

    expect(prisma.payment.update).toHaveBeenCalledWith({
      where: { id: "payment_1" },
      data: {
        classification: PaymentClassification.INCOME,
      },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "payment.classification.updated",
          actorId: "user_1",
        }),
      }),
    );
  });

  it("exposes memo context only through the owner payment DTO", async () => {
    const payment = {
      id: "payment_1",
      userId: "user_1",
      operationId: "op_1",
      stellarTransactionHash: "tx_1",
      sourceAddress: "GA",
      destinationAddress: "GB",
      assetCode: "XLM",
      assetIssuer: null,
      amountEncrypted: "enc:v1:private",
      occurredAt: new Date("2026-07-13T00:00:00Z"),
      memo: { type: "text", value: "Salary June", truncated: false },
      classification: PaymentClassification.INCOME,
      isEligible: true,
      createdAt: new Date("2026-07-13T00:00:00Z"),
      updatedAt: new Date("2026-07-13T00:00:00Z"),
    };
    const prisma = {
      payment: {
        findMany: jest.fn().mockResolvedValue([payment]),
        findFirst: jest.fn().mockResolvedValue(payment),
      },
    };
    const service = new PaymentsService(
      prisma as never,
      {} as never,
      config as never,
    );

    const [listed] = await service.listPayments("user_1", {});
    const detail = await service.getPayment("user_1", "payment_1");

    expect(listed.memoContext).toEqual(payment.memo);
    expect(detail.memoContext).toEqual(payment.memo);
    expect(listed).not.toHaveProperty("memo");
    expect(listed).not.toHaveProperty("amountEncrypted");
    expect(prisma.payment.findFirst).toHaveBeenCalledWith({
      where: { id: "payment_1", userId: "user_1" },
    });
  });

  it("does not make unsupported assets eligible during classification", async () => {
    const prisma = {
      payment: {
        findFirst: jest.fn().mockResolvedValue({
          id: "payment_unsupported",
          classification: PaymentClassification.UNKNOWN,
          assetCode: "FAKE",
          assetIssuer: "GISSUER",
          isEligible: false,
        }),
        update: jest.fn().mockResolvedValue({
          id: "payment_unsupported",
          classification: PaymentClassification.INCOME,
          isEligible: false,
        }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: "audit_2" }),
      },
    };
    const service = new PaymentsService(
      prisma as never,
      {} as never,
      config as never,
    );

    const updated = await service.updateClassification(
      { id: "user_1" },
      "payment_unsupported",
      PaymentClassification.INCOME,
    );

    expect(updated).toMatchObject({
      classification: PaymentClassification.INCOME,
      isEligible: false,
    });
    expect(prisma.payment.update).toHaveBeenCalledWith({
      where: { id: "payment_unsupported" },
      data: {
        classification: PaymentClassification.INCOME,
      },
    });
  });
});

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ConsentWithdrawalStatus, Prisma } from "@prisma/client";
import {
  ConsentWithdrawalService,
  MAX_RECONCILE_BATCH,
  MAX_WITHDRAWAL_ATTEMPTS,
  WITHDRAWAL_RETRY_COOLDOWN_MS,
} from "./consent-withdrawal.service";

const NOW = new Date("2026-11-21T12:00:00.000Z");
const USER = { id: "user-1", role: "WORKER" } as never;
const OTHER_USER = { id: "user-2", role: "WORKER" } as never;
const KEY = "idem-key-0123456789";

const receipt = (overrides: Record<string, unknown> = {}) => ({
  id: "receipt-1",
  organizationId: "org-1",
  expiresAt: new Date(NOW.getTime() + 86_400_000),
  proof: { userId: "user-1" },
  ...overrides,
});

function withdrawal(overrides: Record<string, unknown> = {}) {
  return {
    id: "wd-1",
    subjectUserId: "user-1",
    disclosureReceiptId: "receipt-1",
    organizationId: "org-1",
    idempotencyKey: KEY,
    requestFingerprint: "fp",
    withdrawalCommitment: "c".repeat(64),
    status: ConsentWithdrawalStatus.PENDING,
    attemptCount: 0,
    transactionHash: null,
    failureCode: null,
    requestedAt: NOW,
    lastAttemptAt: null,
    confirmedAt: null,
    ...overrides,
  };
}

function setup(options: {
  receipt?: ReturnType<typeof receipt> | null;
  byKey?: ReturnType<typeof withdrawal> | null;
  byReceipt?: ReturnType<typeof withdrawal> | null;
  byId?: ReturnType<typeof withdrawal> | null;
  claim?: number;
  contract?: unknown;
} = {}) {
  const tx = {
    consentWithdrawal: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) =>
        withdrawal({ ...data, id: "wd-new" }),
      ),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    disclosureReceipt: {
      findUnique: jest
        .fn()
        .mockResolvedValue(options.receipt === undefined ? receipt() : options.receipt),
    },
    consentWithdrawal: {
      findUnique: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if ("subjectUserId_idempotencyKey" in where) return options.byKey ?? null;
        if ("disclosureReceiptId" in where) return options.byReceipt ?? null;
        return options.byId ?? null;
      }),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: options.claim ?? 1 }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const base = withdrawal({ id: where.id });
        const next = { ...base, ...data };
        // Resolve Prisma increment operators the way the database would.
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && "increment" in (v as object)) {
            (next as Record<string, unknown>)[k] =
              ((base as Record<string, unknown>)[k] as number) +
              (v as { increment: number }).increment;
          }
        }
        return next;
      }),
    },
  };
  const contract = options.contract ?? {
    withdrawDisclosureConsent: jest.fn().mockResolvedValue({
      anchored: true,
      transactionHash: "tx-hash-1",
    }),
  };
  return {
    service: new ConsentWithdrawalService(prisma as never, contract as never),
    prisma,
    tx,
    contract: contract as { withdrawDisclosureConsent: jest.Mock },
  };
}

describe("eligibility", () => {
  it("is eligible for an owned, unexpired receipt", async () => {
    const { service } = setup();
    await expect(service.getEligibility(USER, "receipt-1", NOW)).resolves.toEqual({
      disclosureReceiptId: "receipt-1",
      eligible: true,
      reason: null,
      withdrawalId: null,
    });
  });

  it("cannot target another subject, and cannot tell it from a missing receipt", async () => {
    const foreign = await setup()
      .service.getEligibility(OTHER_USER, "receipt-1", NOW)
      .catch((e: unknown) => e);
    const missing = await setup({ receipt: null })
      .service.getEligibility(USER, "nope", NOW)
      .catch((e: unknown) => e);

    expect(foreign).toBeInstanceOf(NotFoundException);
    expect(missing).toBeInstanceOf(NotFoundException);
    expect((foreign as Error).message).toBe((missing as Error).message);
  });

  it.each([
    ["expired", { receipt: receipt({ expiresAt: NOW }) }, "RECEIPT_EXPIRED"],
    [
      "in progress",
      { byReceipt: withdrawal() },
      "WITHDRAWAL_IN_PROGRESS",
    ],
    [
      "failed (retry through reconcile)",
      { byReceipt: withdrawal({ status: ConsentWithdrawalStatus.FAILED }) },
      "WITHDRAWAL_FAILED",
    ],
    [
      "already withdrawn",
      { byReceipt: withdrawal({ status: ConsentWithdrawalStatus.CONFIRMED }) },
      "ALREADY_WITHDRAWN",
    ],
  ])("is ineligible when %s", async (_name, options, reason) => {
    const { service } = setup(options as never);
    const result = await service.getEligibility(USER, "receipt-1", NOW);
    expect(result).toMatchObject({ eligible: false, reason });
  });

  it("is still eligible one millisecond before the receipt expires", async () => {
    const { service } = setup({
      receipt: receipt({ expiresAt: new Date(NOW.getTime() + 1) }),
    });
    expect((await service.getEligibility(USER, "receipt-1", NOW)).eligible).toBe(true);
  });
});

describe("requestWithdrawal", () => {
  it.each([undefined, "", "short", "has spaces in it 1234", "x".repeat(65)])(
    "rejects invalid idempotency key %p without reading any data",
    async (key) => {
      const { service, prisma } = setup();
      await expect(
        service.requestWithdrawal(USER, "receipt-1", key as string, NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.disclosureReceipt.findUnique).not.toHaveBeenCalled();
    },
  );

  it("creates the withdrawal and its audit row in one transaction, then submits", async () => {
    const { service, tx, contract } = setup();
    const result = await service.requestWithdrawal(USER, "receipt-1", KEY, NOW);

    expect(tx.consentWithdrawal.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
      actorType: "user",
      actorId: "user-1",
      action: "proof.consent_withdrawal_requested",
      resourceId: "receipt-1",
    });
    expect(contract.withdrawDisclosureConsent).toHaveBeenCalledWith({
      disclosureReceiptId: "receipt-1",
      withdrawalCommitment: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result.status).toBe(ConsentWithdrawalStatus.CONFIRMED);
  });

  it("keeps the audit trail free of receipt contents", async () => {
    const { service, tx } = setup();
    await service.requestWithdrawal(USER, "receipt-1", KEY, NOW);
    expect(tx.auditLog.create.mock.calls[0][0].data.metadata).toEqual({
      withdrawalId: "wd-new",
    });
  });

  it("fails the request when the audit write fails, creating nothing outside the transaction", async () => {
    const { service, tx, contract } = setup();
    tx.auditLog.create.mockRejectedValueOnce(new Error("audit down"));
    await expect(service.requestWithdrawal(USER, "receipt-1", KEY, NOW)).rejects.toThrow(
      "audit down",
    );
    expect(contract.withdrawDisclosureConsent).not.toHaveBeenCalled();
  });

  it("replays an identical request without creating or submitting again", async () => {
    const first = setup();
    await first.service.requestWithdrawal(USER, "receipt-1", KEY, NOW);
    const fingerprint = first.tx.consentWithdrawal.create.mock.calls[0][0].data.requestFingerprint;

    const { service, tx, contract } = setup({
      byKey: withdrawal({ requestFingerprint: fingerprint }),
    });
    const result = await service.requestWithdrawal(USER, "receipt-1", KEY, NOW);

    expect(result.id).toBe("wd-1");
    expect(tx.consentWithdrawal.create).not.toHaveBeenCalled();
    expect(contract.withdrawDisclosureConsent).not.toHaveBeenCalled();
  });

  it("rejects a key reused for a different receipt", async () => {
    const { service, tx } = setup({ byKey: withdrawal({ requestFingerprint: "other" }) });
    await expect(
      service.requestWithdrawal(USER, "receipt-1", KEY, NOW),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(tx.consentWithdrawal.create).not.toHaveBeenCalled();
  });

  it("does not create anything for another subject's receipt", async () => {
    const { service, tx, contract } = setup();
    await expect(
      service.requestWithdrawal(OTHER_USER, "receipt-1", KEY, NOW),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.consentWithdrawal.create).not.toHaveBeenCalled();
    expect(contract.withdrawDisclosureConsent).not.toHaveBeenCalled();
  });

  it.each([
    ["an expired receipt", { receipt: receipt({ expiresAt: NOW }) }],
    ["a withdrawal already in progress", { byReceipt: withdrawal({ idempotencyKey: "different-key-000000" }) }],
    [
      "an already confirmed withdrawal",
      { byReceipt: withdrawal({ status: ConsentWithdrawalStatus.CONFIRMED }) },
    ],
  ])("conflicts for %s", async (_name, options) => {
    const { service, tx } = setup(options as never);
    await expect(
      service.requestWithdrawal(USER, "receipt-1", KEY, NOW),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.consentWithdrawal.create).not.toHaveBeenCalled();
  });

  it("resolves a concurrent duplicate to the winner's withdrawal", async () => {
    const { service, prisma } = setup();
    prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    // First lookup (before create) finds nothing; after the race the winner exists.
    prisma.consentWithdrawal.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(withdrawal({ id: "wd-winner" }));

    const result = await service.requestWithdrawal(USER, "receipt-1", KEY, NOW);
    expect(result.id).toBe("wd-winner");
  });

  describe("contract outcomes", () => {
    const outcomes: Array<[string, unknown, Partial<{ status: string; attemptCount: number; failureCode: string | null }>]> = [
      ["disabled", { anchored: false, reason: "disabled" }, { status: "PENDING", attemptCount: 0, failureCode: "DISABLED" }],
      ["circuit open", { anchored: false, reason: "circuit_open" }, { status: "PENDING", attemptCount: 0, failureCode: "CIRCUIT_OPEN" }],
      ["sequence busy", { anchored: false, reason: "sequence_busy" }, { status: "PENDING", attemptCount: 0, failureCode: "SEQUENCE_BUSY" }],
      ["fee refused", { anchored: false, reason: "fee_refused" }, { status: "PENDING", attemptCount: 0, failureCode: "FEE_REFUSED" }],
      ["transient failure", { anchored: false, reason: "failed", error: "rpc" }, { status: "PENDING", attemptCount: 1, failureCode: "CONTRACT_UNAVAILABLE" }],
      ["permanent failure", { anchored: false, reason: "failed", failureKind: "permanent" }, { status: "FAILED", attemptCount: 1, failureCode: "CONTRACT_REJECTED" }],
    ];

    it.each(outcomes)("handles %s", async (_name, outcome, expected) => {
      const { service } = setup({
        contract: { withdrawDisclosureConsent: jest.fn().mockResolvedValue(outcome) },
      });
      const result = await service.requestWithdrawal(USER, "receipt-1", KEY, NOW);
      expect(result).toMatchObject(expected);
    });

    it("keeps a thrown contract error out of the stored failure code", async () => {
      const { service } = setup({
        contract: {
          withdrawDisclosureConsent: jest.fn().mockRejectedValue(new Error("secret rpc detail")),
        },
      });
      const result = await service.requestWithdrawal(USER, "receipt-1", KEY, NOW);
      expect(result.failureCode).toBe("CONTRACT_UNAVAILABLE");
      expect(JSON.stringify(result)).not.toContain("secret rpc detail");
    });
  });
});

describe("reconcile", () => {
  it("fails a withdrawal once attempts are exhausted", async () => {
    const { service } = setup({
      byId: withdrawal({ attemptCount: MAX_WITHDRAWAL_ATTEMPTS - 1 }),
      contract: {
        withdrawDisclosureConsent: jest.fn().mockResolvedValue({ anchored: false, reason: "failed" }),
      },
    });
    const result = await service.reconcileWithdrawal(USER, "wd-1", NOW);
    expect(result.status).toBe(ConsentWithdrawalStatus.FAILED);
  });

  it("does not submit when another caller holds the cooldown claim", async () => {
    const { service, contract } = setup({ byId: withdrawal(), claim: 0 });
    const result = await service.reconcileWithdrawal(USER, "wd-1", NOW);
    expect(result.status).toBe(ConsentWithdrawalStatus.PENDING);
    expect(contract.withdrawDisclosureConsent).not.toHaveBeenCalled();
  });

  it("claims with a cooldown no shorter than the configured window", async () => {
    const { service, prisma } = setup({ byId: withdrawal() });
    await service.reconcileWithdrawal(USER, "wd-1", NOW);
    const where = prisma.consentWithdrawal.updateMany.mock.calls[0][0].where;
    expect(where.OR[1].lastAttemptAt.lt).toEqual(
      new Date(NOW.getTime() - WITHDRAWAL_RETRY_COOLDOWN_MS),
    );
  });

  it("returns a confirmed withdrawal untouched", async () => {
    const { service, contract } = setup({
      byId: withdrawal({ status: ConsentWithdrawalStatus.CONFIRMED, confirmedAt: NOW }),
    });
    const result = await service.reconcileWithdrawal(USER, "wd-1", NOW);
    expect(result.status).toBe(ConsentWithdrawalStatus.CONFIRMED);
    expect(contract.withdrawDisclosureConsent).not.toHaveBeenCalled();
  });

  it("re-arms a failed withdrawal only when the re-arm claim succeeds", async () => {
    const { service, contract } = setup({
      byId: withdrawal({ status: ConsentWithdrawalStatus.FAILED, attemptCount: 5 }),
      claim: 0,
    });
    const result = await service.reconcileWithdrawal(USER, "wd-1", NOW);
    expect(result.status).toBe(ConsentWithdrawalStatus.FAILED);
    expect(contract.withdrawDisclosureConsent).not.toHaveBeenCalled();
  });

  it("will not reconcile another subject's withdrawal", async () => {
    const { service } = setup({ byId: withdrawal() });
    await expect(service.reconcileWithdrawal(OTHER_USER, "wd-1", NOW)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("reconciles a bounded batch of due withdrawals", async () => {
    const { service, prisma, contract } = setup();
    prisma.consentWithdrawal.findMany.mockResolvedValue([
      withdrawal({ id: "a" }),
      withdrawal({ id: "b" }),
    ]);

    await expect(service.reconcilePending(NOW)).resolves.toEqual({ attempted: 2, confirmed: 2 });

    const query = prisma.consentWithdrawal.findMany.mock.calls[0][0];
    expect(query.take).toBe(MAX_RECONCILE_BATCH);
    expect(query.where.attemptCount).toEqual({ lt: MAX_WITHDRAWAL_ATTEMPTS });
    expect(contract.withdrawDisclosureConsent).toHaveBeenCalledTimes(2);
  });

  it("does not count rows another worker already claimed", async () => {
    const { service, prisma } = setup({ claim: 0 });
    prisma.consentWithdrawal.findMany.mockResolvedValue([withdrawal()]);
    await expect(service.reconcilePending(NOW)).resolves.toEqual({ attempted: 0, confirmed: 0 });
  });
});

describe("status and receipt", () => {
  it("returns status only to the subject", async () => {
    const { service } = setup({ byId: withdrawal() });
    await expect(service.getWithdrawal(USER, "wd-1")).resolves.toMatchObject({
      id: "wd-1",
      maxAttempts: MAX_WITHDRAWAL_ATTEMPTS,
    });
    await expect(service.getWithdrawal(OTHER_USER, "wd-1")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("withholds the receipt until the withdrawal is confirmed", async () => {
    const { service } = setup({ byId: withdrawal() });
    await expect(service.getReceipt(USER, "wd-1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("issues a receipt that never claims deletion of immutable records", async () => {
    const { service } = setup({
      byId: withdrawal({
        status: ConsentWithdrawalStatus.CONFIRMED,
        transactionHash: "tx-9",
        confirmedAt: NOW,
      }),
    });
    const receiptView = await service.getReceipt(USER, "wd-1");

    expect(receiptView).toMatchObject({
      status: "CONFIRMED",
      transactionHash: "tx-9",
      recordsDeleted: false,
    });
    expect(receiptView.statement).toMatch(/immutable/i);
    expect(receiptView.statement).toMatch(/not deleted/i);
    expect(Object.keys(receiptView)).not.toContain("idempotencyKey");
  });

  it("will not issue another subject's receipt", async () => {
    const { service } = setup({
      byId: withdrawal({ status: ConsentWithdrawalStatus.CONFIRMED, transactionHash: "t", confirmedAt: NOW }),
    });
    await expect(service.getReceipt(OTHER_USER, "wd-1")).rejects.toBeInstanceOf(NotFoundException);
  });
});

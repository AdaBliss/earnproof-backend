import {
  AnchoringOperation,
  AnchoringStatus,
  QuarantineReasonCode,
} from "@prisma/client";
import { AnchoringWorkerService } from "./anchoring-worker.service";
import {
  SEQUENCE_RECOVERY_MAX_ATTEMPTS,
  SequenceRecoveryGate,
  isBadSequenceError,
  sequenceRecoveryDelayMs,
} from "../stellar/sequence-recovery";

const BAD_SEQ = "transaction failed: tx_bad_seq";
const failed = (error: string) => ({ anchored: false, reason: "failed", error });
const ok = (transactionHash = "tx_ok") => ({ anchored: true, transactionHash });

function makeConfig() {
  return {
    get: jest.fn((key: string) => {
      if (key === "contractAnchoring.enabled") return true;
      // No real waiting between reconciliation rounds in tests.
      if (key === "contractAnchoring.sequenceRecovery.baseDelayMs") return 0;
      return undefined;
    }),
  };
}

function makeIntent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    proofId: `proof_${id}`,
    operation: AnchoringOperation.REGISTER,
    status: AnchoringStatus.PROCESSING,
    attemptCount: 0,
    proof: { commitment: "sha256:abc", expiresAt: new Date("2027-01-01") },
    ...overrides,
  };
}

function makePrisma(intents: Array<ReturnType<typeof makeIntent>>) {
  const byId = new Map(intents.map((intent) => [intent.id, intent]));
  return {
    anchoringIntent: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => byId.get(where.id)),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    proof: { update: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
  };
}

function makeAnchoring(overrides: Record<string, unknown> = {}) {
  return {
    anchorProof: jest.fn(),
    revokeProof: jest.fn(),
    getProofStatus: jest.fn().mockResolvedValue({ checked: true, valid: false, revoked: false }),
    circuitState: jest.fn().mockReturnValue("closed"),
    ...overrides,
  };
}

function build(
  intents: Array<ReturnType<typeof makeIntent>>,
  anchoring: ReturnType<typeof makeAnchoring>,
) {
  const prisma = makePrisma(intents);
  const worker = new AnchoringWorkerService(
    prisma as never,
    anchoring as never,
    makeConfig() as never,
  );
  return { prisma, worker };
}

function lastUpdateData(prisma: ReturnType<typeof makePrisma>) {
  const calls = prisma.anchoringIntent.update.mock.calls;
  return calls[calls.length - 1][0].data;
}

describe("AnchoringWorkerService sequence recovery", () => {
  it("retries once after an external sequence advance when the intent is not on-chain", async () => {
    const anchoring = makeAnchoring();
    anchoring.anchorProof
      .mockResolvedValueOnce(failed(BAD_SEQ))
      .mockResolvedValueOnce(ok("tx_recovered"));
    const { prisma, worker } = build([makeIntent("a")], anchoring);

    await worker.processIntent("a");

    expect(anchoring.getProofStatus).toHaveBeenCalledWith("proof_a", {
      signal: expect.any(AbortSignal),
    });
    expect(anchoring.anchorProof).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.anchoringIntent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: AnchoringStatus.CONFIRMED,
          transactionHash: "tx_recovered",
        }),
      }),
    );
  });

  it("does not resubmit an intent that is already registered on-chain", async () => {
    const anchoring = makeAnchoring({
      getProofStatus: jest.fn().mockResolvedValue({ checked: true, valid: true, revoked: false }),
    });
    anchoring.anchorProof.mockResolvedValueOnce(failed(BAD_SEQ));
    const { prisma, worker } = build([makeIntent("a")], anchoring);

    await worker.processIntent("a");

    expect(anchoring.anchorProof).toHaveBeenCalledTimes(1);
    expect(lastUpdateData(prisma)).toMatchObject({ status: AnchoringStatus.CONFIRMED });
    // No transaction hash is invented for a submission this worker did not make.
    expect(prisma.proof.update).not.toHaveBeenCalled();
  });

  it("does not resubmit a REVOKE that is already revoked on-chain", async () => {
    const anchoring = makeAnchoring({
      getProofStatus: jest.fn().mockResolvedValue({ checked: true, valid: false, revoked: true }),
    });
    anchoring.revokeProof.mockResolvedValueOnce(failed(BAD_SEQ));
    const { prisma, worker } = build(
      [makeIntent("r", { operation: AnchoringOperation.REVOKE })],
      anchoring,
    );

    await worker.processIntent("r");

    expect(anchoring.revokeProof).toHaveBeenCalledTimes(1);
    expect(lastUpdateData(prisma)).toMatchObject({ status: AnchoringStatus.CONFIRMED });
  });

  it("does not retry blindly when on-chain state cannot be verified", async () => {
    const anchoring = makeAnchoring({
      getProofStatus: jest.fn().mockResolvedValue({ checked: false, reason: "failed" }),
    });
    anchoring.anchorProof.mockResolvedValueOnce(failed(BAD_SEQ));
    const { prisma, worker } = build([makeIntent("a")], anchoring);

    await worker.processIntent("a");

    expect(anchoring.anchorProof).toHaveBeenCalledTimes(1);
    // Back to the normal transient backoff, not quarantined and not confirmed.
    expect(lastUpdateData(prisma)).toMatchObject({
      status: AnchoringStatus.PENDING,
      attemptCount: 1,
    });
  });

  it("enters a visible terminal state when divergence is irrecoverable", async () => {
    const anchoring = makeAnchoring();
    anchoring.anchorProof.mockResolvedValue(failed(BAD_SEQ));
    const { prisma, worker } = build([makeIntent("a")], anchoring);

    await worker.processIntent("a");

    // One initial attempt plus exactly the bounded number of recovery attempts.
    expect(anchoring.anchorProof).toHaveBeenCalledTimes(1 + SEQUENCE_RECOVERY_MAX_ATTEMPTS);
    expect(lastUpdateData(prisma)).toMatchObject({
      status: AnchoringStatus.QUARANTINED,
      quarantineReasonCode: QuarantineReasonCode.SEQUENCE_DIVERGENCE,
      permanentError: true,
      nextRetryAt: null,
    });
  });

  it("stops recovering when a later attempt fails for a different reason", async () => {
    const anchoring = makeAnchoring();
    anchoring.anchorProof
      .mockResolvedValueOnce(failed(BAD_SEQ))
      .mockResolvedValueOnce(failed("RPC timeout"));
    const { prisma, worker } = build([makeIntent("a")], anchoring);

    await worker.processIntent("a");

    expect(anchoring.anchorProof).toHaveBeenCalledTimes(2);
    expect(lastUpdateData(prisma)).toMatchObject({ status: AnchoringStatus.PENDING });
  });

  it("recovers concurrent intents one at a time without duplicating either", async () => {
    let active = 0;
    let maxActive = 0;
    const onChain = new Set<string>();
    const anchoring = makeAnchoring({
      getProofStatus: jest.fn(async (proofId: string) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return { checked: true, valid: onChain.has(proofId), revoked: false };
      }),
    });
    const submissions: string[] = [];
    const attemptsByProof = new Map<string, number>();
    anchoring.anchorProof.mockImplementation(async ({ proofId }: { proofId: string }) => {
      const attempt = (attemptsByProof.get(proofId) ?? 0) + 1;
      attemptsByProof.set(proofId, attempt);
      if (attempt === 1) return failed(BAD_SEQ);
      submissions.push(proofId);
      onChain.add(proofId);
      return ok(`tx_${proofId}`);
    });
    const { worker } = build([makeIntent("a"), makeIntent("b")], anchoring);

    await Promise.all([worker.processIntent("a"), worker.processIntent("b")]);

    expect(maxActive).toBe(1);
    expect([...submissions].sort()).toEqual(["proof_a", "proof_b"]);
    expect(anchoring.anchorProof).toHaveBeenCalledTimes(4);
  });

  it("leaves non-sequence failures on the existing path without any reconciliation", async () => {
    const anchoring = makeAnchoring();
    anchoring.anchorProof.mockResolvedValueOnce(failed("RPC timeout"));
    const { prisma, worker } = build([makeIntent("a")], anchoring);

    await worker.processIntent("a");

    expect(anchoring.getProofStatus).not.toHaveBeenCalled();
    expect(lastUpdateData(prisma)).toMatchObject({ status: AnchoringStatus.PENDING });
  });

  it("holds an intent without spending an attempt when the fee policy refuses", async () => {
    const anchoring = makeAnchoring();
    anchoring.anchorProof.mockResolvedValueOnce({
      anchored: false,
      reason: "fee_refused",
      error: "Contract submission refused by fee policy: refused_over_threshold",
    });
    const { prisma, worker } = build([makeIntent("a", { attemptCount: 2 })], anchoring);
    const before = Date.now();

    await worker.processIntent("a");

    const data = lastUpdateData(prisma);
    expect(data.status).toBe(AnchoringStatus.PENDING);
    expect(data).not.toHaveProperty("attemptCount");
    expect((data.nextRetryAt as Date).getTime()).toBeGreaterThan(before);
  });

  it("keeps terminal intents untouched (authorization and idempotency of redrive remain operator-only)", async () => {
    const anchoring = makeAnchoring();
    const { prisma, worker } = build(
      [makeIntent("q", { status: AnchoringStatus.QUARANTINED })],
      anchoring,
    );

    await worker.processIntent("q");

    expect(anchoring.anchorProof).not.toHaveBeenCalled();
    expect(prisma.anchoringIntent.update).not.toHaveBeenCalled();
  });
});

describe("bad sequence classification", () => {
  it.each([
    "transaction failed: tx_bad_seq",
    "TxBadSeq",
    "error: bad sequence number",
    "Bad-Sequence",
  ])("recognises %p", (message) => {
    expect(isBadSequenceError(message)).toBe(true);
  });

  it.each(["RPC timeout", "already registered", "tx_insufficient_fee", ""])(
    "ignores %p",
    (message) => {
      expect(isBadSequenceError(message)).toBe(false);
    },
  );
});

describe("sequence recovery helpers", () => {
  it("jitters delays within a bounded window and honours a zero base", () => {
    expect(sequenceRecoveryDelayMs(1, 0)).toBe(0);
    expect(sequenceRecoveryDelayMs(2, 500, () => 0)).toBe(500);
    expect(sequenceRecoveryDelayMs(2, 500, () => 0.999)).toBeLessThanOrEqual(1000);
  });

  it("gate serializes tasks and survives a rejected task", async () => {
    const gate = new SequenceRecoveryGate();
    const order: string[] = [];
    const first = gate.run(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      order.push("first");
      throw new Error("boom");
    });
    const second = gate.run(async () => {
      order.push("second");
      return 2;
    });

    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(["first", "second"]);
  });
});

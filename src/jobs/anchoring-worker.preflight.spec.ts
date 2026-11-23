import {
  AnchoringOperation,
  AnchoringStatus,
  QuarantineReasonCode,
} from "@prisma/client";
import { AnchoringWorkerService } from "./anchoring-worker.service";

/**
 * How the worker reacts to the preflight / sequence-coordination outcomes of
 * the anchoring service (simulation rejections, busy source account,
 * sequence conflicts).
 */

function intent(overrides: Record<string, unknown> = {}) {
  return {
    id: "intent_1",
    proofId: "proof_1",
    operation: AnchoringOperation.REGISTER,
    status: AnchoringStatus.PENDING,
    attemptCount: 2,
    proof: { commitment: "sha256:abc", expiresAt: new Date("2027-01-01") },
    ...overrides,
  };
}

function setup(anchorResult: unknown, intentOverrides?: Record<string, unknown>) {
  const row = intent(intentOverrides);
  const prisma = {
    anchoringIntent: {
      findUnique: jest.fn().mockResolvedValue(row),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(row),
    },
    proof: { update: jest.fn() },
    $transaction: jest.fn(),
  };
  const anchoring = {
    anchorProof: jest.fn().mockResolvedValue(anchorResult),
    revokeProof: jest.fn().mockResolvedValue(anchorResult),
  };
  const worker = new AnchoringWorkerService(
    prisma as never,
    anchoring as never,
    { get: () => true } as never,
  );
  return { worker, prisma };
}

const lastUpdate = (prisma: ReturnType<typeof setup>["prisma"]) =>
  prisma.anchoringIntent.update.mock.calls.at(-1)![0].data;

describe("AnchoringWorkerService preflight outcomes", () => {
  it("releases an intent without consuming an attempt when the source account is busy", async () => {
    const { worker, prisma } = setup({ anchored: false, reason: "sequence_busy" });

    await worker.processIntent("intent_1");

    const data = lastUpdate(prisma);
    expect(data.status).toBe(AnchoringStatus.PENDING);
    expect(data).not.toHaveProperty("attemptCount");
    expect(data.nextRetryAt).toBeInstanceOf(Date);
  });

  it("also releases a busy revocation", async () => {
    const { worker, prisma } = setup(
      { anchored: false, reason: "sequence_busy" },
      { operation: AnchoringOperation.REVOKE },
    );

    await worker.processIntent("intent_1");

    expect(lastUpdate(prisma).status).toBe(AnchoringStatus.PENDING);
    expect(lastUpdate(prisma)).not.toHaveProperty("attemptCount");
  });

  it("quarantines a deterministic simulation rejection instead of retrying it", async () => {
    const { worker, prisma } = setup({
      anchored: false,
      reason: "failed",
      failureKind: "permanent",
      error: "Contract simulation rejected: contract_rejected",
    });

    await worker.processIntent("intent_1");

    expect(lastUpdate(prisma)).toMatchObject({
      status: AnchoringStatus.QUARANTINED,
      permanentError: true,
      quarantineReasonCode: QuarantineReasonCode.CHAIN_REJECTED,
      nextRetryAt: null,
    });
  });

  it("retries a sequence conflict within seconds, not on the transport backoff", async () => {
    const { worker, prisma } = setup({
      anchored: false,
      reason: "failed",
      failureKind: "sequence_conflict",
      error: "transaction failed: tx_bad_seq",
    });
    const before = Date.now();

    await worker.processIntent("intent_1");

    const data = lastUpdate(prisma);
    expect(data.status).toBe(AnchoringStatus.PENDING);
    expect(data.permanentError).toBe(false);
    // Attempt 3 on the transport schedule would be 2 minutes; conflicts use 5s.
    const delay = (data.nextRetryAt as Date).getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(4_000);
    expect(delay).toBeLessThanOrEqual(6_000);
    // It still consumes an attempt, so it stays bounded.
    expect(data.attemptCount).toBe(3);
  });

  it("keeps the exponential backoff for plain transport failures", async () => {
    const { worker, prisma } = setup({
      anchored: false,
      reason: "failed",
      error: "connect ECONNREFUSED",
    });
    const before = Date.now();

    await worker.processIntent("intent_1");

    const delay = (lastUpdate(prisma).nextRetryAt as Date).getTime() - before;
    expect(delay).toBeGreaterThan(100_000);
  });

  it("retries a restore-required simulation as transient", async () => {
    const { worker, prisma } = setup({
      anchored: false,
      reason: "failed",
      error: "Contract simulation rejected: restore_required",
    });

    await worker.processIntent("intent_1");

    expect(lastUpdate(prisma)).toMatchObject({
      status: AnchoringStatus.PENDING,
      permanentError: false,
    });
  });
});

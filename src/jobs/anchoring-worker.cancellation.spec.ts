import { AnchoringOperation, AnchoringStatus } from "@prisma/client";
import { AnchoringWorkerService } from "./anchoring-worker.service";

const intent = {
  id: "intent_1",
  proofId: "proof_1",
  operation: AnchoringOperation.REGISTER,
  status: AnchoringStatus.PENDING,
  attemptCount: 0,
  proof: { commitment: "sha256:abc", expiresAt: new Date("2027-01-01") },
};

function makePrisma() {
  return {
    anchoringIntent: {
      findUnique: jest.fn().mockResolvedValue(intent),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(intent),
    },
    proof: { update: jest.fn() },
    $transaction: jest.fn().mockResolvedValue([]),
  };
}

const config = { get: (key: string) => (key === "contractAnchoring.enabled" ? true : undefined) };

function build(anchoring: Record<string, jest.Mock>, prisma = makePrisma()) {
  const worker = new AnchoringWorkerService(
    prisma as never,
    anchoring as never,
    config as never,
  );
  return { worker, prisma };
}

describe("AnchoringWorkerService cancellation", () => {
  it("releases the intent without recording success when the service reports cancellation", async () => {
    const anchoring = {
      anchorProof: jest.fn().mockResolvedValue({ anchored: false, reason: "cancelled" }),
      revokeProof: jest.fn(),
      circuitState: jest.fn().mockReturnValue("closed"),
    };
    const { worker, prisma } = build(anchoring);

    await worker.processIntent("intent_1");

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.anchoringIntent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "intent_1" },
        data: expect.objectContaining({ status: AnchoringStatus.PENDING }),
      }),
    );
    expect(prisma.anchoringIntent.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: AnchoringStatus.CONFIRMED }),
      }),
    );
  });

  it("does not consume an attempt when cancelled", async () => {
    const anchoring = {
      anchorProof: jest.fn().mockResolvedValue({ anchored: false, reason: "cancelled" }),
      revokeProof: jest.fn(),
      circuitState: jest.fn().mockReturnValue("closed"),
    };
    const { worker, prisma } = build(anchoring);

    await worker.processIntent("intent_1");

    for (const [arg] of prisma.anchoringIntent.update.mock.calls) {
      expect(arg.data).not.toHaveProperty("attemptCount");
    }
  });

  it("never confirms an intent whose call succeeded after shutdown aborted the worker", async () => {
    let signal: AbortSignal | undefined;
    const anchoring = {
      anchorProof: jest.fn().mockImplementation(async (_input, options) => {
        signal = options.signal;
        // Shutdown drain budget exhausted while the call was in flight; the
        // late result still reads as a success.
        (worker as unknown as { shutdownController: AbortController }).shutdownController.abort();
        return { anchored: true, transactionHash: "tx_late" };
      }),
      revokeProof: jest.fn(),
      circuitState: jest.fn().mockReturnValue("closed"),
    };
    const { worker, prisma } = build(anchoring);

    await worker.processIntent("intent_1");

    expect(signal?.aborted).toBe(true);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.proof.update).not.toHaveBeenCalled();
    expect(prisma.anchoringIntent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: AnchoringStatus.PENDING }),
      }),
    );
  });

  it("treats a deadline timeout as a counted transient failure, not as success", async () => {
    const anchoring = {
      anchorProof: jest.fn().mockResolvedValue({
        anchored: false,
        reason: "timeout",
        error: "Contract anchoring exceeded its 120000ms deadline",
      }),
      revokeProof: jest.fn(),
      circuitState: jest.fn().mockReturnValue("closed"),
    };
    const { worker, prisma } = build(anchoring);

    await worker.processIntent("intent_1");

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.anchoringIntent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ attemptCount: 1, permanentError: false }),
      }),
    );
  });

  it("aborts the shared signal when the shutdown drain budget is exhausted", async () => {
    jest.useFakeTimers();
    try {
      const anchoring = { circuitState: jest.fn() };
      const { worker } = build(anchoring as never);
      (worker as unknown as { inFlightCycle: Promise<void> }).inFlightCycle = new Promise(() => {});
      const controller = (worker as unknown as { shutdownController: AbortController })
        .shutdownController;
      expect(controller.signal.aborted).toBe(false);

      const shutdown = worker.onApplicationShutdown("SIGTERM");
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      await shutdown;

      expect(controller.signal.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

import { ProofStatus } from "@prisma/client";
import { AnchoringReconcilerService } from "./anchoring-reconciler.service";

function build(getProofStatus: jest.Mock, config: Record<string, unknown> = {}) {
  const prisma = {
    proof: {
      findMany: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    anchoringIntent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
  };
  const service = new AnchoringReconcilerService(
    prisma as never,
    { getProofStatus } as never,
    { get: (key: string) => config[key] } as never,
  );
  return { service, prisma };
}

const activeProof = {
  id: "proof_1",
  status: ProofStatus.ACTIVE,
  contractTransactionHash: "tx_1",
};

describe("AnchoringReconcilerService deadlines", () => {
  it("passes a cancellation signal to every contract read", async () => {
    const getProofStatus = jest
      .fn()
      .mockResolvedValue({ checked: true, revoked: false, valid: true });
    const { service, prisma } = build(getProofStatus);
    prisma.proof.findMany.mockResolvedValue([activeProof]);

    await (service as unknown as { runReconcile(): Promise<void> }).runReconcile();

    expect(getProofStatus).toHaveBeenCalledWith("proof_1", {
      signal: expect.any(AbortSignal),
    });
  });

  it("suppresses a late result: no repair when the run was cancelled mid-read", async () => {
    const controller = new AbortController();
    const getProofStatus = jest.fn().mockImplementation(async () => {
      controller.abort();
      // Late result claiming on-chain revoked: must NOT mark the proof REVOKED.
      return { checked: true, revoked: true, valid: false };
    });
    const { service, prisma } = build(getProofStatus);

    await service.reconcileProof(activeProof, { signal: controller.signal });

    expect(prisma.proof.update).not.toHaveBeenCalled();
  });

  it("still repairs when the signal never aborts (regression)", async () => {
    const getProofStatus = jest
      .fn()
      .mockResolvedValue({ checked: true, revoked: true, valid: false });
    const { service, prisma } = build(getProofStatus);

    await service.reconcileProof(activeProof, { signal: new AbortController().signal });

    expect(prisma.proof.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: ProofStatus.REVOKED }) }),
    );
  });

  it("stops the batch and defers the rest once the run deadline elapses", async () => {
    jest.useFakeTimers();
    try {
      const getProofStatus = jest.fn().mockImplementation(async () => {
        // Each read burns the whole 5s run budget (the configured minimum).
        jest.advanceTimersByTime(5_000);
        return { checked: true, revoked: false, valid: true };
      });
      const { service, prisma } = build(getProofStatus, {
        "contractAnchoring.deadlines.reconcileRunMs": 5_000,
      });
      prisma.proof.findMany.mockResolvedValue([
        activeProof,
        { ...activeProof, id: "proof_2" },
        { ...activeProof, id: "proof_3" },
      ]);

      await (service as unknown as { runReconcile(): Promise<void> }).runReconcile();

      expect(getProofStatus).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("clamps an unusably small run deadline to the 5s floor", async () => {
    jest.useFakeTimers();
    try {
      const getProofStatus = jest.fn().mockImplementation(async () => {
        jest.advanceTimersByTime(4_999);
        return { checked: true, revoked: false, valid: true };
      });
      const { service, prisma } = build(getProofStatus, {
        "contractAnchoring.deadlines.reconcileRunMs": 1,
      });
      prisma.proof.findMany.mockResolvedValue([activeProof, { ...activeProof, id: "proof_2" }]);

      await (service as unknown as { runReconcile(): Promise<void> }).runReconcile();

      // 4999ms < 5000ms floor: the second proof is still processed.
      expect(getProofStatus).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

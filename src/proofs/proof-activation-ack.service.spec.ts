import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Prisma, ProofActivationAckStatus } from "@prisma/client";
import {
  ACTIVATION_PROJECTION_STALE_MS,
  MAX_EVIDENCE_PAGE,
  ProofActivationAckEvent,
  ProofActivationAckService,
} from "./proof-activation-ack.service";

const NOW = new Date("2026-11-21T12:00:00.000Z");
const OWNER = { id: "user-1", role: "WORKER" } as never;
const OTHER = { id: "user-2", role: "WORKER" } as never;
const ADMIN = { id: "admin-1", role: "ADMIN" } as never;

function event(overrides: Partial<ProofActivationAckEvent> = {}): ProofActivationAckEvent {
  return {
    id: "evt-1",
    ledger: 200,
    proofId: "proof-1",
    kind: "REQUIRED",
    requirementKey: "issuer.countersign",
    requiredRole: "ISSUER",
    ...overrides,
  };
}

function ackRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ack-1",
    proofId: "proof-1",
    requirementKey: "issuer.countersign",
    requiredRole: "ISSUER",
    status: ProofActivationAckStatus.REQUIRED,
    requiredLedger: 200,
    completedLedger: null,
    completedAt: null,
    eventId: null,
    ...overrides,
  };
}

function setup(options: {
  existingAck?: ReturnType<typeof ackRow> | null;
  existingProjection?: { observedLedger: number } | null;
  proof?: { id: string; userId: string } | null;
  rows?: ReturnType<typeof ackRow>[];
  groups?: Array<{ status: ProofActivationAckStatus; _count: { _all: number } }>;
  projection?: { observedLedger: number; lastReconciledAt: Date } | null;
} = {}) {
  const tx = {
    contractEventApplied: { create: jest.fn().mockResolvedValue({}) },
    proofActivationAcknowledgement: {
      findUnique: jest.fn().mockResolvedValue(options.existingAck ?? null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    proofActivationProjection: {
      findUnique: jest.fn().mockResolvedValue(options.existingProjection ?? null),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
  const proofUpdate = jest.fn();
  const prisma = {
    $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    proof: {
      findUnique: jest.fn().mockResolvedValue(
        options.proof === undefined ? { id: "proof-1", userId: "user-1" } : options.proof,
      ),
      update: proofUpdate,
      updateMany: proofUpdate,
    },
    proofActivationAcknowledgement: {
      findMany: jest.fn().mockResolvedValue(options.rows ?? []),
      groupBy: jest.fn().mockResolvedValue(options.groups ?? []),
    },
    proofActivationProjection: {
      findUnique: jest.fn().mockResolvedValue(options.projection ?? null),
    },
  };
  return {
    service: new ProofActivationAckService(prisma as never),
    prisma,
    tx,
    proofUpdate,
  };
}

describe("ProofActivationAckService.ingest", () => {
  it("records a required acknowledgement and refreshes the projection", async () => {
    const { service, tx } = setup();
    await expect(service.ingest(event(), NOW)).resolves.toBe(true);

    expect(tx.proofActivationAcknowledgement.create.mock.calls[0][0].data).toMatchObject({
      proofId: "proof-1",
      requirementKey: "issuer.countersign",
      status: ProofActivationAckStatus.REQUIRED,
      requiredLedger: 200,
    });
    expect(tx.proofActivationProjection.upsert.mock.calls[0][0].create).toEqual({
      proofId: "proof-1",
      observedLedger: 200,
      lastReconciledAt: NOW,
    });
  });

  it("completes a requirement", async () => {
    const { service, tx } = setup({ existingAck: ackRow() });
    await service.ingest(event({ id: "evt-2", kind: "COMPLETED", ledger: 210 }), NOW);

    expect(tx.proofActivationAcknowledgement.update.mock.calls[0][0].data).toMatchObject({
      status: ProofActivationAckStatus.COMPLETED,
      completedLedger: 210,
      completedAt: NOW,
      eventId: "evt-2",
    });
  });

  it("never downgrades a completed requirement on a late required event", async () => {
    const { service, tx } = setup({
      existingAck: ackRow({ status: ProofActivationAckStatus.COMPLETED }),
    });
    await service.ingest(event({ id: "evt-late", ledger: 150 }), NOW);

    expect(tx.proofActivationAcknowledgement.create).not.toHaveBeenCalled();
    expect(tx.proofActivationAcknowledgement.update).not.toHaveBeenCalled();
  });

  it("keeps the highest observed ledger when events arrive out of order", async () => {
    const { service, tx } = setup({ existingProjection: { observedLedger: 500 } });
    await service.ingest(event({ ledger: 300 }), NOW);
    expect(tx.proofActivationProjection.upsert.mock.calls[0][0].update.observedLedger).toBe(500);
  });

  it("treats a replayed event as a no-op", async () => {
    const { service, prisma } = setup();
    prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    await expect(service.ingest(event(), NOW)).resolves.toBe(false);
  });

  it("never writes to the proof", async () => {
    const { service, proofUpdate } = setup({ existingAck: ackRow() });
    await service.ingest(event({ kind: "COMPLETED", id: "evt-3" }), NOW);
    expect(proofUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown kind", { kind: "VALID" as never }],
    ["uppercase requirement key", { requirementKey: "Issuer" }],
    ["oversized requirement key", { requirementKey: "a".repeat(65) }],
    ["lowercase role", { requiredRole: "issuer" }],
    ["negative ledger", { ledger: -1 }],
    ["empty proof id", { proofId: "" }],
  ])("rejects %s", async (_name, overrides) => {
    const { service, prisma } = setup();
    await expect(service.ingest(event(overrides), NOW)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("ProofActivationAckService.getEvidence", () => {
  const fresh = { observedLedger: 210, lastReconciledAt: new Date(NOW.getTime() - 1_000) };
  const stale = {
    observedLedger: 210,
    lastReconciledAt: new Date(NOW.getTime() - ACTIVATION_PROJECTION_STALE_MS - 1),
  };
  const groups = [
    { status: ProofActivationAckStatus.COMPLETED, _count: { _all: 2 } },
    { status: ProofActivationAckStatus.REQUIRED, _count: { _all: 1 } },
  ];

  it("returns bounded, non-authoritative evidence to the owner", async () => {
    const { service } = setup({
      rows: [ackRow(), ackRow({ id: "ack-2", requirementKey: "z.second" })],
      groups,
      projection: fresh,
    });
    const evidence = await service.getEvidence(OWNER, "proof-1", 25, NOW);

    expect(evidence.summary).toEqual({ required: 3, completed: 2, pending: 1 });
    expect(evidence.projection.state).toBe("FRESH");
    expect(evidence.allRequiredAcknowledged).toBe(false);
    expect(evidence.authoritative).toBe(false);
    expect(evidence.proofValidity).toBe("NOT_DETERMINED");
    expect(evidence.truncated).toBe(true);
  });

  it("reports completion only while the projection is fresh", async () => {
    const done = [{ status: ProofActivationAckStatus.COMPLETED, _count: { _all: 2 } }];

    const freshView = await setup({ groups: done, projection: fresh }).service.getEvidence(
      OWNER,
      "proof-1",
      25,
      NOW,
    );
    expect(freshView.allRequiredAcknowledged).toBe(true);

    const staleView = await setup({ groups: done, projection: stale }).service.getEvidence(
      OWNER,
      "proof-1",
      25,
      NOW,
    );
    expect(staleView.projection.state).toBe("STALE");
    expect(staleView.allRequiredAcknowledged).toBeNull();
    expect(staleView.proofValidity).toBe("NOT_DETERMINED");
  });

  it("reports an unavailable projection explicitly", async () => {
    const view = await setup().service.getEvidence(OWNER, "proof-1", 25, NOW);
    expect(view.projection).toMatchObject({ state: "UNAVAILABLE", lastReconciledAt: null });
    expect(view.allRequiredAcknowledged).toBeNull();
  });

  it("treats a projection exactly at the stale boundary as fresh", async () => {
    const edge = {
      observedLedger: 1,
      lastReconciledAt: new Date(NOW.getTime() - ACTIVATION_PROJECTION_STALE_MS),
    };
    const view = await setup({ projection: edge }).service.getEvidence(OWNER, "proof-1", 25, NOW);
    expect(view.projection.state).toBe("FRESH");
  });

  it("does not report completion when nothing is required", async () => {
    const view = await setup({ projection: fresh }).service.getEvidence(OWNER, "proof-1", 25, NOW);
    expect(view.summary.required).toBe(0);
    expect(view.allRequiredAcknowledged).toBeNull();
  });

  it("hides proofs from other users exactly as it hides missing proofs", async () => {
    const foreign = await setup().service
      .getEvidence(OTHER, "proof-1", 25, NOW)
      .catch((e: unknown) => e);
    const missing = await setup({ proof: null }).service
      .getEvidence(OWNER, "nope", 25, NOW)
      .catch((e: unknown) => e);

    expect(foreign).toBeInstanceOf(NotFoundException);
    expect(missing).toBeInstanceOf(NotFoundException);
    expect((foreign as Error).message).toBe((missing as Error).message);
  });

  it("does not query acknowledgements for a proof the caller cannot see", async () => {
    const { service, prisma } = setup();
    await expect(service.getEvidence(OTHER, "proof-1", 25, NOW)).rejects.toThrow();
    expect(prisma.proofActivationAcknowledgement.findMany).not.toHaveBeenCalled();
  });

  it("lets an administrator read any proof's evidence", async () => {
    const view = await setup({ projection: fresh }).service.getEvidence(ADMIN, "proof-1", 25, NOW);
    expect(view.proofId).toBe("proof-1");
  });

  it("clamps the page size", async () => {
    const { service, prisma } = setup();
    await service.getEvidence(OWNER, "proof-1", 100_000, NOW);
    await service.getEvidence(OWNER, "proof-1", Number.NaN, NOW);
    await service.getEvidence(OWNER, "proof-1", 0, NOW);

    const takes = prisma.proofActivationAcknowledgement.findMany.mock.calls.map(
      (c: [{ take: number }]) => c[0].take,
    );
    expect(takes).toEqual([MAX_EVIDENCE_PAGE, 25, 25]);
  });
});

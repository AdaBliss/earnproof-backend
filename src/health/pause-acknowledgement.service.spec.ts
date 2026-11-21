import { BadRequestException } from "@nestjs/common";
import { PauseAcknowledgementActorRole, Prisma } from "@prisma/client";
import {
  MAX_ACKNOWLEDGEMENT_PAGE,
  PAUSE_PROJECTION_FRESH_MS,
  PauseAcknowledgementEvent,
  PauseAcknowledgementService,
} from "./pause-acknowledgement.service";

const COMMITMENT_A = "a".repeat(64);
const COMMITMENT_B = "b".repeat(64);
const NOW = new Date("2026-11-21T12:00:00.000Z");

function event(overrides: Partial<PauseAcknowledgementEvent> = {}): PauseAcknowledgementEvent {
  return {
    id: "evt-1",
    ledger: 100,
    network: "testnet",
    contractId: "CONTRACT1",
    sequence: "1",
    actorRole: PauseAcknowledgementActorRole.GUARDIAN,
    scopes: ["ISSUANCE", "ANCHORING"],
    incidentCommitment: COMMITMENT_A,
    ...overrides,
  };
}

function row(sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `row-${sequence}`,
    network: "testnet",
    contractId: "CONTRACT1",
    sequence: BigInt(sequence),
    eventId: `evt-${sequence}`,
    ledger: 100 + sequence,
    actorRole: PauseAcknowledgementActorRole.GUARDIAN,
    scopes: ["ISSUANCE"],
    incidentCommitment: COMMITMENT_A,
    observedAt: NOW,
    ...overrides,
  };
}

function fixture(options: {
  rows?: ReturnType<typeof row>[];
  total?: number;
  pauseState?: Record<string, unknown> | null;
} = {}) {
  const rows = options.rows ?? [];
  const tx = {
    contractEventApplied: { create: jest.fn().mockResolvedValue({}) },
    pauseAcknowledgement: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    pauseAcknowledgement: {
      // Rows are supplied newest first, as the service orders its query.
      findMany: jest.fn().mockResolvedValue(rows),
      count: jest.fn().mockResolvedValue(options.total ?? rows.length),
      groupBy: jest.fn().mockResolvedValue(
        rows.length
          ? [{ actorRole: PauseAcknowledgementActorRole.GUARDIAN, _count: { _all: rows.length } }]
          : [],
      ),
    },
    protocolPauseState: {
      findUnique: jest.fn().mockResolvedValue(
        options.pauseState === undefined
          ? { isPaused: true, incidentCommitment: COMMITMENT_A, lastCheckedAt: NOW }
          : options.pauseState,
      ),
    },
  };
  return { service: new PauseAcknowledgementService(prisma as never), prisma, tx };
}

describe("PauseAcknowledgementService.ingest", () => {
  it("stores only the declared fields and never incident content", async () => {
    const { service, tx } = fixture();
    const hostile = {
      ...event(),
      incidentNotes: "private narrative",
      reporter: "someone@example.com",
    } as PauseAcknowledgementEvent;

    await expect(service.ingest(hostile)).resolves.toBe(true);

    const data = tx.pauseAcknowledgement.create.mock.calls[0][0].data;
    expect(Object.keys(data).sort()).toEqual(
      [
        "actorRole",
        "contractId",
        "eventId",
        "incidentCommitment",
        "ledger",
        "network",
        "scopes",
        "sequence",
      ].sort(),
    );
    expect(Object.values(data)).not.toContain("private narrative");
    expect(data.sequence).toBe(1n);
    expect(data.scopes).toEqual(["ANCHORING", "ISSUANCE"]);
  });

  it("applies an event once and treats a replay as a no-op", async () => {
    const { service, prisma } = fixture();
    prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    await expect(service.ingest(event())).resolves.toBe(false);
  });

  it("propagates non-duplicate storage failures", async () => {
    const { service, prisma } = fixture();
    prisma.$transaction.mockRejectedValueOnce(new Error("db down"));
    await expect(service.ingest(event())).rejects.toThrow("db down");
  });

  it.each([
    ["uppercase commitment", { incidentCommitment: "A".repeat(64) }],
    ["short commitment", { incidentCommitment: "abc" }],
    ["negative sequence", { sequence: "-1" }],
    ["non-numeric sequence", { sequence: "1e3" }],
    ["leading-zero sequence", { sequence: "01" }],
    ["sequence above int64", { sequence: "9223372036854775808" }],
    ["unknown role", { actorRole: "ROOT" as PauseAcknowledgementActorRole }],
    ["lowercase scope", { scopes: ["issuance"] }],
    ["too many scopes", { scopes: Array.from({ length: 17 }, (_, i) => `S${i}`) }],
    ["negative ledger", { ledger: -1 }],
    ["fractional ledger", { ledger: 1.5 }],
    ["empty contract id", { contractId: "" }],
  ])("rejects %s before touching storage", async (_name, overrides) => {
    const { service, prisma } = fixture();
    await expect(service.ingest(event(overrides))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("accepts the largest int64 sequence", async () => {
    const { service } = fixture();
    await expect(
      service.ingest(event({ sequence: "9223372036854775807" })),
    ).resolves.toBe(true);
  });
});

describe("PauseAcknowledgementService.getStatus", () => {
  it("reports no sequence and an unverified state when nothing is indexed", async () => {
    const { service } = fixture({ rows: [], pauseState: null });
    const status = await service.getStatus("testnet", "CONTRACT1", 20, NOW);

    expect(status.currentSequence).toBeNull();
    expect(status.acknowledgementCount).toBe(0);
    expect(status.consistency.status).toBe("UNVERIFIED");
    expect(status.consistency.findings.map((f) => f.code)).toEqual([
      "PAUSE_STATE_UNKNOWN",
    ]);
  });

  it("is consistent for contiguous sequences that match a fresh pause", async () => {
    const { service } = fixture({ rows: [row(3), row(2), row(1)] });
    const status = await service.getStatus("testnet", "CONTRACT1", 20, NOW);

    expect(status.currentSequence).toBe("3");
    expect(status.latestIncidentCommitment).toBe(COMMITMENT_A);
    expect(status.actorRoleCounts).toEqual({ GUARDIAN: 3, OPERATOR: 0, ADMIN: 0 });
    expect(status.consistency).toEqual({ status: "CONSISTENT", findings: [] });
    expect(status.truncated).toBe(false);
  });

  it("flags a sequence gap as inconsistent", async () => {
    const { service } = fixture({ rows: [row(4), row(2), row(1)] });
    const status = await service.getStatus("testnet", "CONTRACT1", 20, NOW);

    expect(status.consistency.status).toBe("INCONSISTENT");
    expect(status.consistency.findings[0]).toMatchObject({
      code: "SEQUENCE_GAP",
      severity: "blocking",
    });
  });

  it("flags two different events claiming one sequence", async () => {
    const { service } = fixture({
      rows: [row(2), row(2, { id: "dup", eventId: "evt-other" }), row(1)],
    });
    const status = await service.getStatus("testnet", "CONTRACT1", 20, NOW);

    expect(status.consistency.findings.map((f) => f.code)).toContain(
      "CONFLICTING_SEQUENCE",
    );
    expect(status.consistency.status).toBe("INCONSISTENT");
  });

  it("flags a commitment that differs from the active pause", async () => {
    const { service } = fixture({
      rows: [row(1, { incidentCommitment: COMMITMENT_B })],
    });
    const status = await service.getStatus("testnet", "CONTRACT1", 20, NOW);

    expect(status.consistency.findings.map((f) => f.code)).toContain(
      "COMMITMENT_MISMATCH",
    );
  });

  it("does not compare commitments once the contract is unpaused", async () => {
    const { service } = fixture({
      rows: [row(1, { incidentCommitment: COMMITMENT_B })],
      pauseState: { isPaused: false, incidentCommitment: COMMITMENT_A, lastCheckedAt: NOW },
    });
    const status = await service.getStatus("testnet", "CONTRACT1", 20, NOW);
    expect(status.consistency.status).toBe("CONSISTENT");
  });

  it("marks a stale pause projection as unverified rather than consistent", async () => {
    const { service } = fixture({
      rows: [row(1)],
      pauseState: {
        isPaused: true,
        incidentCommitment: COMMITMENT_A,
        lastCheckedAt: new Date(NOW.getTime() - PAUSE_PROJECTION_FRESH_MS - 1),
      },
    });
    const status = await service.getStatus("testnet", "CONTRACT1", 20, NOW);

    expect(status.consistency.status).toBe("UNVERIFIED");
    expect(status.consistency.findings.map((f) => f.code)).toEqual([
      "PAUSE_STATE_STALE",
    ]);
  });

  it("treats a projection exactly at the freshness boundary as fresh", async () => {
    const { service } = fixture({
      rows: [row(1)],
      pauseState: {
        isPaused: true,
        incidentCommitment: COMMITMENT_A,
        lastCheckedAt: new Date(NOW.getTime() - PAUSE_PROJECTION_FRESH_MS),
      },
    });
    const status = await service.getStatus("testnet", "CONTRACT1", 20, NOW);
    expect(status.consistency.status).toBe("CONSISTENT");
  });

  it("bounds the page size and reports truncation", async () => {
    const { service, prisma } = fixture({ rows: [row(2), row(1)], total: 500 });

    const status = await service.getStatus("testnet", "CONTRACT1", 10_000, NOW);
    expect(prisma.pauseAcknowledgement.findMany.mock.calls[0][0].take).toBe(
      MAX_ACKNOWLEDGEMENT_PAGE,
    );
    expect(status.truncated).toBe(true);
    expect(status.acknowledgementCount).toBe(500);

    await service.getStatus("testnet", "CONTRACT1", Number.NaN, NOW);
    expect(prisma.pauseAcknowledgement.findMany.mock.calls[1][0].take).toBe(20);
    await service.getStatus("testnet", "CONTRACT1", -5, NOW);
    expect(prisma.pauseAcknowledgement.findMany.mock.calls[2][0].take).toBe(20);
  });

  it("never grants unpause authority and exposes no private incident fields", async () => {
    const { service } = fixture({ rows: [row(1)] });
    const status = await service.getStatus("testnet", "CONTRACT1", 20, NOW);

    expect(status.grantsUnpauseAuthority).toBe(false);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toMatch(/notes|narrative|reporter|email/i);
    expect(Object.keys(status.acknowledgements[0]).sort()).toEqual([
      "actorRole",
      "incidentCommitment",
      "ledger",
      "observedAt",
      "scopes",
      "sequence",
    ]);
  });

  it("is deterministic for identical state", async () => {
    const { service } = fixture({ rows: [row(2), row(1)] });
    const a = await service.getStatus("testnet", "CONTRACT1", 20, NOW);
    const b = await service.getStatus("testnet", "CONTRACT1", 20, NOW);
    expect(a).toEqual(b);
  });
});

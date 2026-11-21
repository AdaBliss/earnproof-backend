import { BadRequestException } from "@nestjs/common";
import { ContractLifecyclePhase } from "@prisma/client";
import {
  buildPolicy,
  ContractDecommissionService,
  CONTRACT_CAPABILITIES,
  DECOMMISSION_STATE_FRESH_MS,
  DecommissionStateEvent,
} from "./contract-decommission.service";

const NOW = new Date("2026-11-21T12:00:00.000Z");
const HOUR = 3_600_000;

function stateRow(overrides: Record<string, unknown> = {}) {
  return {
    phase: ContractLifecyclePhase.GRACE,
    graceStartsAt: new Date(NOW.getTime() - HOUR),
    graceEndsAt: new Date(NOW.getTime() + HOUR),
    allowedCapabilities: ["REVOKE"],
    successorContractId: "SUCCESSOR1",
    terminal: false,
    observedLedger: 10n,
    lastCheckedAt: NOW,
    ...overrides,
  } as Parameters<typeof buildPolicy>[2] & { observedLedger: bigint };
}

function allowedSet(policy: ReturnType<typeof buildPolicy>) {
  return CONTRACT_CAPABILITIES.filter((c) => policy.capabilities[c].allowed);
}

describe("buildPolicy", () => {
  it("denies every mutation for an unknown contract but still allows reads", () => {
    const policy = buildPolicy("testnet", "C1", null, NOW);

    expect(policy.effectivePhase).toBe("UNKNOWN");
    expect(allowedSet(policy)).toEqual(["READ", "VERIFY"]);
    expect(policy.capabilities.ISSUE).toEqual({ allowed: false, reason: "UNKNOWN_CONTRACT" });
  });

  it("allows everything for a fresh active contract", () => {
    const policy = buildPolicy(
      "testnet",
      "C1",
      stateRow({ phase: ContractLifecyclePhase.ACTIVE, graceStartsAt: null, graceEndsAt: null }),
      NOW,
    );
    expect(allowedSet(policy)).toEqual([...CONTRACT_CAPABILITIES]);
  });

  it("allows only listed mutations inside the grace window", () => {
    const policy = buildPolicy("testnet", "C1", stateRow(), NOW);

    expect(policy.effectivePhase).toBe(ContractLifecyclePhase.GRACE);
    expect(allowedSet(policy)).toEqual(["READ", "VERIFY", "REVOKE"]);
    expect(policy.capabilities.ISSUE.reason).toBe("CAPABILITY_NOT_ALLOWED_IN_GRACE");
    expect(policy.successorContractId).toBe("SUCCESSOR1");
  });

  it("fails closed at the exact instant the grace period ends", () => {
    const endsAt = new Date(NOW.getTime());
    const policy = buildPolicy("testnet", "C1", stateRow({ graceEndsAt: endsAt }), NOW);

    expect(policy.effectivePhase).toBe(ContractLifecyclePhase.DECOMMISSIONED);
    expect(policy.capabilities.REVOKE).toEqual({ allowed: false, reason: "GRACE_EXPIRED" });
  });

  it("is still in grace one millisecond before the end", () => {
    const endsAt = new Date(NOW.getTime() + 1);
    const policy = buildPolicy("testnet", "C1", stateRow({ graceEndsAt: endsAt }), NOW);
    expect(policy.capabilities.REVOKE.allowed).toBe(true);
  });

  it("treats a grace that has not started as active", () => {
    const policy = buildPolicy(
      "testnet",
      "C1",
      stateRow({ graceStartsAt: new Date(NOW.getTime() + HOUR), graceEndsAt: new Date(NOW.getTime() + 2 * HOUR) }),
      NOW,
    );
    expect(policy.effectivePhase).toBe(ContractLifecyclePhase.ACTIVE);
    expect(policy.capabilities.ISSUE.allowed).toBe(true);
  });

  it("fails closed when a grace row has no end", () => {
    const policy = buildPolicy("testnet", "C1", stateRow({ graceEndsAt: null }), NOW);
    expect(policy.effectivePhase).toBe(ContractLifecyclePhase.DECOMMISSIONED);
    expect(policy.capabilities.REVOKE.allowed).toBe(false);
  });

  it("denies all mutations on a terminal contract, whatever the indexed phase", () => {
    const policy = buildPolicy(
      "testnet",
      "C1",
      stateRow({ phase: ContractLifecyclePhase.DECOMMISSIONED, terminal: true, allowedCapabilities: ["ISSUE"] }),
      NOW,
    );
    expect(allowedSet(policy)).toEqual(["READ", "VERIFY"]);
    expect(policy.capabilities.ISSUE.reason).toBe("DECOMMISSIONED");
    expect(policy.terminal).toBe(true);
  });

  it("does not let a stale projection authorize any mutation", () => {
    const stale = new Date(NOW.getTime() - DECOMMISSION_STATE_FRESH_MS - 1);
    const policy = buildPolicy("testnet", "C1", stateRow({ lastCheckedAt: stale }), NOW);

    expect(policy.isFresh).toBe(false);
    expect(allowedSet(policy)).toEqual(["READ", "VERIFY"]);
    expect(policy.capabilities.REVOKE.reason).toBe("STALE_STATE");
  });

  it("accepts a projection exactly at the freshness boundary", () => {
    const edge = new Date(NOW.getTime() - DECOMMISSION_STATE_FRESH_MS);
    const policy = buildPolicy("testnet", "C1", stateRow({ lastCheckedAt: edge }), NOW);
    expect(policy.isFresh).toBe(true);
    expect(policy.capabilities.REVOKE.allowed).toBe(true);
  });

  it("reports a stale terminal contract as decommissioned, not merely stale", () => {
    const stale = new Date(NOW.getTime() - DECOMMISSION_STATE_FRESH_MS - 1);
    const policy = buildPolicy(
      "testnet",
      "C1",
      stateRow({ phase: ContractLifecyclePhase.DECOMMISSIONED, terminal: true, lastCheckedAt: stale }),
      NOW,
    );
    expect(policy.capabilities.ISSUE.reason).toBe("DECOMMISSIONED");
  });

  it("is deterministic for the same state and instant", () => {
    expect(buildPolicy("testnet", "C1", stateRow(), NOW)).toEqual(
      buildPolicy("testnet", "C1", stateRow(), NOW),
    );
  });
});

describe("ContractDecommissionService", () => {
  function setup(existing: Record<string, unknown> | null = null) {
    const prisma = {
      contractDecommissionState: {
        findUnique: jest.fn().mockResolvedValue(existing),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    return { service: new ContractDecommissionService(prisma as never), prisma };
  }

  function graceEvent(overrides: Partial<DecommissionStateEvent> = {}): DecommissionStateEvent {
    return {
      network: "testnet",
      contractId: "C1",
      phase: ContractLifecyclePhase.GRACE,
      graceStartsAt: new Date(NOW.getTime()),
      graceEndsAt: new Date(NOW.getTime() + 24 * HOUR),
      allowedCapabilities: ["VERIFY", "REVOKE", "REVOKE"],
      successorContractId: "C2",
      terminal: false,
      observedLedger: "50",
      ...overrides,
    };
  }

  it("indexes a grace event with deduplicated, sorted capabilities", async () => {
    const { service, prisma } = setup();
    await expect(service.applyState(graceEvent(), NOW)).resolves.toBe(true);

    const call = prisma.contractDecommissionState.upsert.mock.calls[0][0];
    expect(call.create.allowedCapabilities).toEqual(["REVOKE", "VERIFY"]);
    expect(call.create.observedLedger).toBe(50n);
    expect(call.create.successorContractId).toBe("C2");
  });

  it("ignores an event from an older or equal ledger", async () => {
    const { service, prisma } = setup({ observedLedger: 50n, terminal: false });
    await expect(service.applyState(graceEvent({ observedLedger: "50" }), NOW)).resolves.toBe(false);
    await expect(service.applyState(graceEvent({ observedLedger: "49" }), NOW)).resolves.toBe(false);
    expect(prisma.contractDecommissionState.upsert).not.toHaveBeenCalled();
  });

  it("never reopens a terminal contract", async () => {
    const { service, prisma } = setup({ observedLedger: 50n, terminal: true });
    await expect(
      service.applyState(
        graceEvent({ observedLedger: "999", phase: ContractLifecyclePhase.ACTIVE, graceStartsAt: null, graceEndsAt: null }),
        NOW,
      ),
    ).resolves.toBe(false);
    expect(prisma.contractDecommissionState.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown capability", { allowedCapabilities: ["SUDO"] }],
    ["grace without a window", { graceEndsAt: null }],
    ["grace that ends before it starts", { graceEndsAt: new Date(NOW.getTime() - HOUR) }],
    ["grace longer than a year", { graceEndsAt: new Date(NOW.getTime() + 400 * 24 * HOUR) }],
    ["decommissioned but not terminal", { phase: ContractLifecyclePhase.DECOMMISSIONED, terminal: false }],
    ["active but terminal", { phase: ContractLifecyclePhase.ACTIVE, terminal: true }],
    ["self as successor", { successorContractId: "C1" }],
    ["malformed ledger", { observedLedger: "12abc" }],
    ["empty contract id", { contractId: "" }],
  ])("rejects %s", async (_name, overrides) => {
    const { service, prisma } = setup();
    await expect(
      service.applyState(graceEvent(overrides as Partial<DecommissionStateEvent>), NOW),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.contractDecommissionState.upsert).not.toHaveBeenCalled();
  });

  it("answers a single capability from the stored state", async () => {
    const { service } = setup(stateRow());
    await expect(service.evaluate("testnet", "C1", "REVOKE", NOW)).resolves.toEqual({
      allowed: true,
      reason: null,
    });
    await expect(service.evaluate("testnet", "C1", "ISSUE", NOW)).resolves.toEqual({
      allowed: false,
      reason: "CAPABILITY_NOT_ALLOWED_IN_GRACE",
    });
  });
});

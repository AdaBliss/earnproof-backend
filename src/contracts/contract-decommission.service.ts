import { BadRequestException, Injectable } from "@nestjs/common";
import { ContractLifecyclePhase } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";

/** Actions a service may ask to perform against a contract. */
export const CONTRACT_CAPABILITIES = [
  "READ",
  "VERIFY",
  "REVOKE",
  "ISSUE",
  "ANCHOR",
  "MIGRATE",
] as const;
export type ContractCapability = (typeof CONTRACT_CAPABILITIES)[number];

/** Capabilities that never change contract state. Always permitted. */
const NON_MUTATING: ReadonlySet<ContractCapability> = new Set([
  "READ",
  "VERIFY",
]);

/** State older than this cannot authorize a mutation. */
export const DECOMMISSION_STATE_FRESH_MS = 5 * 60 * 1000;
/** Longest grace window an indexed event may declare. */
export const MAX_GRACE_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

export type DecommissionDenialReason =
  | "UNKNOWN_CONTRACT"
  | "STALE_STATE"
  | "GRACE_EXPIRED"
  | "DECOMMISSIONED"
  | "CAPABILITY_NOT_ALLOWED_IN_GRACE";

export interface DecommissionStateEvent {
  network: string;
  contractId: string;
  phase: ContractLifecyclePhase;
  graceStartsAt?: Date | null;
  graceEndsAt?: Date | null;
  allowedCapabilities?: string[];
  successorContractId?: string | null;
  terminal: boolean;
  observedLedger: string;
}

export interface DecommissionPolicyDto {
  network: string;
  contractId: string;
  /** Phase after applying the clock: an elapsed grace reads as DECOMMISSIONED. */
  effectivePhase: ContractLifecyclePhase | "UNKNOWN";
  /** Phase as last indexed. */
  indexedPhase: ContractLifecyclePhase | null;
  graceStartsAt: string | null;
  graceEndsAt: string | null;
  successorContractId: string | null;
  terminal: boolean;
  isFresh: boolean;
  lastCheckedAt: string | null;
  /** Authoritative per-capability decision at `evaluatedAt`. */
  capabilities: Record<
    ContractCapability,
    { allowed: boolean; reason: DecommissionDenialReason | null }
  >;
  evaluatedAt: string;
}

type StateRow = {
  phase: ContractLifecyclePhase;
  graceStartsAt: Date | null;
  graceEndsAt: Date | null;
  allowedCapabilities: string[];
  successorContractId: string | null;
  terminal: boolean;
  lastCheckedAt: Date;
};

@Injectable()
export class ContractDecommissionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Indexes a successor or decommission state change.
   *
   * Monotonic in ledger: an older observation is ignored. A terminal state is
   * sticky, so a later event cannot reopen a decommissioned contract.
   *
   * @returns false when the event was ignored as stale.
   */
  async applyState(
    event: DecommissionStateEvent,
    now: Date = new Date(),
  ): Promise<boolean> {
    const valid = this.validate(event);

    const existing = await this.prisma.contractDecommissionState.findUnique({
      where: {
        network_contractId: {
          network: event.network,
          contractId: event.contractId,
        },
      },
    });

    if (existing) {
      if (valid.observedLedger <= existing.observedLedger) return false;
      if (existing.terminal) return false;
    }

    const data = {
      phase: event.phase,
      graceStartsAt: valid.graceStartsAt,
      graceEndsAt: valid.graceEndsAt,
      allowedCapabilities: valid.allowedCapabilities,
      successorContractId: valid.successorContractId,
      terminal: event.terminal,
      observedLedger: valid.observedLedger,
      lastCheckedAt: now,
    };

    await this.prisma.contractDecommissionState.upsert({
      where: {
        network_contractId: {
          network: event.network,
          contractId: event.contractId,
        },
      },
      create: { network: event.network, contractId: event.contractId, ...data },
      update: data,
    });
    return true;
  }

  /** The authoritative action policy for a contract at `now`. */
  async getPolicy(
    network: string,
    contractId: string,
    now: Date = new Date(),
  ): Promise<DecommissionPolicyDto> {
    const row = await this.prisma.contractDecommissionState.findUnique({
      where: { network_contractId: { network, contractId } },
    });
    return buildPolicy(network, contractId, row, now);
  }

  /** Convenience for callers that need one decision rather than the policy. */
  async evaluate(
    network: string,
    contractId: string,
    capability: ContractCapability,
    now: Date = new Date(),
  ): Promise<{ allowed: boolean; reason: DecommissionDenialReason | null }> {
    const policy = await this.getPolicy(network, contractId, now);
    return policy.capabilities[capability];
  }

  private validate(event: DecommissionStateEvent) {
    if (
      !event.network ||
      event.network.length > 32 ||
      !event.contractId ||
      event.contractId.length > 128
    ) {
      throw new BadRequestException("Invalid contract identity.");
    }
    if (!/^(0|[1-9][0-9]{0,18})$/.test(event.observedLedger)) {
      throw new BadRequestException("Invalid observed ledger.");
    }
    const allowed = event.allowedCapabilities ?? [];
    if (
      allowed.length > CONTRACT_CAPABILITIES.length ||
      allowed.some(
        (capability) =>
          !(CONTRACT_CAPABILITIES as readonly string[]).includes(capability),
      )
    ) {
      throw new BadRequestException("Unknown capability.");
    }
    if (
      event.successorContractId &&
      (event.successorContractId === event.contractId ||
        event.successorContractId.length > 128)
    ) {
      throw new BadRequestException("Invalid successor contract.");
    }

    const startsAt = event.graceStartsAt ?? null;
    const endsAt = event.graceEndsAt ?? null;
    if (event.phase === ContractLifecyclePhase.GRACE) {
      if (!startsAt || !endsAt || endsAt <= startsAt) {
        throw new BadRequestException("A grace period needs a valid window.");
      }
      if (endsAt.getTime() - startsAt.getTime() > MAX_GRACE_WINDOW_MS) {
        throw new BadRequestException("Grace window exceeds the maximum.");
      }
    }
    if (event.phase === ContractLifecyclePhase.DECOMMISSIONED && !event.terminal) {
      throw new BadRequestException("A decommissioned contract must be terminal.");
    }
    if (event.phase === ContractLifecyclePhase.ACTIVE && event.terminal) {
      throw new BadRequestException("An active contract cannot be terminal.");
    }

    return {
      graceStartsAt: startsAt,
      graceEndsAt: endsAt,
      allowedCapabilities: [...new Set(allowed)].sort(),
      successorContractId: event.successorContractId ?? null,
      observedLedger: BigInt(event.observedLedger),
    };
  }
}

/**
 * Pure policy derivation, separated so the boundary rules are testable without
 * a database. Every uncertain input resolves to "deny the mutation":
 *
 * - no state, or state older than the freshness window: no mutation;
 * - grace not yet started: treated as ACTIVE;
 * - grace elapsed (end is exclusive), or end missing: DECOMMISSIONED;
 * - terminal or DECOMMISSIONED: no mutation, ever;
 * - in grace: only mutations the indexed state lists.
 */
export function buildPolicy(
  network: string,
  contractId: string,
  row: StateRow | null,
  now: Date,
): DecommissionPolicyDto {
  const isFresh =
    row !== null &&
    now.getTime() - row.lastCheckedAt.getTime() <= DECOMMISSION_STATE_FRESH_MS;

  let effectivePhase: DecommissionPolicyDto["effectivePhase"] = "UNKNOWN";
  if (row) {
    effectivePhase = row.phase;
    if (row.terminal) {
      effectivePhase = ContractLifecyclePhase.DECOMMISSIONED;
    } else if (row.phase === ContractLifecyclePhase.GRACE) {
      if (!row.graceEndsAt || now.getTime() >= row.graceEndsAt.getTime()) {
        effectivePhase = ContractLifecyclePhase.DECOMMISSIONED;
      } else if (row.graceStartsAt && now.getTime() < row.graceStartsAt.getTime()) {
        effectivePhase = ContractLifecyclePhase.ACTIVE;
      }
    }
  }

  const capabilities = {} as DecommissionPolicyDto["capabilities"];
  for (const capability of CONTRACT_CAPABILITIES) {
    capabilities[capability] = decide(capability, row, effectivePhase, isFresh);
  }

  return {
    network,
    contractId,
    effectivePhase,
    indexedPhase: row?.phase ?? null,
    graceStartsAt: row?.graceStartsAt?.toISOString() ?? null,
    graceEndsAt: row?.graceEndsAt?.toISOString() ?? null,
    successorContractId: row?.successorContractId ?? null,
    terminal: row?.terminal ?? false,
    isFresh,
    lastCheckedAt: row?.lastCheckedAt.toISOString() ?? null,
    capabilities,
    evaluatedAt: now.toISOString(),
  };
}

function decide(
  capability: ContractCapability,
  row: StateRow | null,
  effectivePhase: DecommissionPolicyDto["effectivePhase"],
  isFresh: boolean,
): { allowed: boolean; reason: DecommissionDenialReason | null } {
  if (NON_MUTATING.has(capability)) return { allowed: true, reason: null };

  if (!row) return { allowed: false, reason: "UNKNOWN_CONTRACT" };
  if (effectivePhase === ContractLifecyclePhase.DECOMMISSIONED) {
    const elapsedGrace =
      !row.terminal && row.phase === ContractLifecyclePhase.GRACE;
    return {
      allowed: false,
      reason: elapsedGrace ? "GRACE_EXPIRED" : "DECOMMISSIONED",
    };
  }
  // Stale state is checked after the terminal rules so a stale terminal
  // contract still reports why it is closed.
  if (!isFresh) return { allowed: false, reason: "STALE_STATE" };

  if (row.phase === ContractLifecyclePhase.GRACE && effectivePhase === ContractLifecyclePhase.GRACE) {
    return row.allowedCapabilities.includes(capability)
      ? { allowed: true, reason: null }
      : { allowed: false, reason: "CAPABILITY_NOT_ALLOWED_IN_GRACE" };
  }
  return { allowed: true, reason: null };
}

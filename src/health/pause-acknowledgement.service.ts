import { BadRequestException, Injectable } from "@nestjs/common";
import { PauseAcknowledgementActorRole } from "@prisma/client";
import {
  applyProjectionEventOnce,
  ProjectionEvent,
} from "../contracts/event-projection";
import { PrismaService } from "../database/prisma.service";

/** Most acknowledgements one status response can carry. */
export const MAX_ACKNOWLEDGEMENT_PAGE = 100;
export const DEFAULT_ACKNOWLEDGEMENT_PAGE = 20;
/** A pause-state projection older than this cannot vouch for consistency. */
export const PAUSE_PROJECTION_FRESH_MS = 5 * 60 * 1000;

const MAX_SCOPES = 16;
const SCOPE_PATTERN = /^[A-Z0-9_]{1,64}$/;
const COMMITMENT_PATTERN = /^[a-f0-9]{64}$/;
const SEQUENCE_PATTERN = /^(0|[1-9][0-9]{0,18})$/;
const MAX_SEQUENCE = 9_223_372_036_854_775_807n;

/**
 * An acknowledgement event as the indexer hands it over. Only these fields are
 * copied at ingestion: incident content never reaches the database.
 */
export interface PauseAcknowledgementEvent extends ProjectionEvent {
  network: string;
  contractId: string;
  sequence: string;
  actorRole: PauseAcknowledgementActorRole;
  scopes: string[];
  incidentCommitment: string;
}

export type PauseConsistencyFindingCode =
  | "SEQUENCE_GAP"
  | "CONFLICTING_SEQUENCE"
  | "COMMITMENT_MISMATCH"
  | "PAUSE_STATE_UNKNOWN"
  | "PAUSE_STATE_STALE";

export interface PauseConsistencyFinding {
  code: PauseConsistencyFindingCode;
  severity: "blocking" | "advisory";
  detail: string;
}

export interface PauseAcknowledgementStatusDto {
  network: string;
  contractId: string;
  /** Highest acknowledgement sequence indexed, or null when none. */
  currentSequence: string | null;
  acknowledgementCount: number;
  latestScopes: string[];
  latestIncidentCommitment: string | null;
  actorRoleCounts: Record<PauseAcknowledgementActorRole, number>;
  acknowledgements: Array<{
    sequence: string;
    actorRole: PauseAcknowledgementActorRole;
    ledger: number;
    scopes: string[];
    incidentCommitment: string;
    observedAt: string;
  }>;
  /** True when more acknowledgements exist than this response carries. */
  truncated: boolean;
  consistency: {
    status: "CONSISTENT" | "INCONSISTENT" | "UNVERIFIED";
    findings: PauseConsistencyFinding[];
  };
  /**
   * Always false. An acknowledgement records that a role saw the pause; it never
   * grants authority to unpause, and nothing here can be used as one.
   */
  grantsUnpauseAuthority: false;
}

@Injectable()
export class PauseAcknowledgementService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Projects one acknowledgement event. Idempotent per event id.
   *
   * @returns false when the event had already been applied.
   */
  async ingest(event: PauseAcknowledgementEvent): Promise<boolean> {
    const valid = this.validate(event);

    return applyProjectionEventOnce(
      this.prisma,
      `${valid.network}:${valid.contractId}`,
      event,
      async (tx) => {
        await tx.pauseAcknowledgement.create({
          data: {
            network: valid.network,
            contractId: valid.contractId,
            sequence: valid.sequence,
            eventId: event.id,
            ledger: event.ledger,
            actorRole: valid.actorRole,
            scopes: valid.scopes,
            incidentCommitment: valid.incidentCommitment,
          },
        });
      },
    );
  }

  /** Current acknowledgement sequence, scope and consistency for a contract. */
  async getStatus(
    network: string,
    contractId: string,
    limit: number = DEFAULT_ACKNOWLEDGEMENT_PAGE,
    now: Date = new Date(),
  ): Promise<PauseAcknowledgementStatusDto> {
    const pageSize = clampLimit(limit);
    const where = { network, contractId };

    const [recent, total, roleGroups, pauseState] = await Promise.all([
      this.prisma.pauseAcknowledgement.findMany({
        where,
        orderBy: [{ sequence: "desc" }, { ledger: "desc" }, { id: "desc" }],
        take: pageSize,
      }),
      this.prisma.pauseAcknowledgement.count({ where }),
      this.prisma.pauseAcknowledgement.groupBy({
        by: ["actorRole"],
        where,
        _count: { _all: true },
      }),
      this.prisma.protocolPauseState.findUnique({
        where: { network_contractId: { network, contractId } },
      }),
    ]);

    const actorRoleCounts: Record<PauseAcknowledgementActorRole, number> = {
      GUARDIAN: 0,
      OPERATOR: 0,
      ADMIN: 0,
    };
    for (const group of roleGroups) {
      actorRoleCounts[group.actorRole] = group._count._all;
    }

    const latest = recent[0] ?? null;
    const findings = this.findConsistencyFindings(recent, pauseState, now);
    const blocking = findings.some((f) => f.severity === "blocking");
    const unverified = findings.length > 0 && !blocking;

    return {
      network,
      contractId,
      currentSequence: latest ? latest.sequence.toString() : null,
      acknowledgementCount: total,
      latestScopes: latest?.scopes ?? [],
      latestIncidentCommitment: latest?.incidentCommitment ?? null,
      actorRoleCounts,
      acknowledgements: recent.map((row) => ({
        sequence: row.sequence.toString(),
        actorRole: row.actorRole,
        ledger: row.ledger,
        scopes: row.scopes,
        incidentCommitment: row.incidentCommitment,
        observedAt: row.observedAt.toISOString(),
      })),
      truncated: total > recent.length,
      consistency: {
        status: blocking
          ? "INCONSISTENT"
          : unverified
            ? "UNVERIFIED"
            : "CONSISTENT",
        findings,
      },
      grantsUnpauseAuthority: false,
    };
  }

  private findConsistencyFindings(
    recentDescending: Array<{
      sequence: bigint;
      incidentCommitment: string;
      eventId: string;
    }>,
    pauseState: {
      isPaused: boolean;
      incidentCommitment: string | null;
      lastCheckedAt: Date;
    } | null,
    now: Date,
  ): PauseConsistencyFinding[] {
    const findings: PauseConsistencyFinding[] = [];

    // Gaps and conflicts are judged inside the returned window only, so the
    // check stays bounded however long the acknowledgement history is.
    const ascending = [...recentDescending].reverse();
    for (let i = 1; i < ascending.length; i += 1) {
      const previous = ascending[i - 1];
      const current = ascending[i];
      if (current.sequence === previous.sequence) {
        if (current.eventId !== previous.eventId) {
          findings.push({
            code: "CONFLICTING_SEQUENCE",
            severity: "blocking",
            detail: `Sequence ${current.sequence.toString()} was reported by more than one event.`,
          });
        }
      } else if (current.sequence !== previous.sequence + 1n) {
        findings.push({
          code: "SEQUENCE_GAP",
          severity: "blocking",
          detail: `Sequence jumps from ${previous.sequence.toString()} to ${current.sequence.toString()}.`,
        });
      }
    }

    if (!pauseState) {
      findings.push({
        code: "PAUSE_STATE_UNKNOWN",
        severity: "advisory",
        detail: "No pause state is indexed for this contract.",
      });
      return findings;
    }

    if (
      now.getTime() - pauseState.lastCheckedAt.getTime() >
      PAUSE_PROJECTION_FRESH_MS
    ) {
      findings.push({
        code: "PAUSE_STATE_STALE",
        severity: "advisory",
        detail:
          "The pause-state projection is stale, so consistency is unverified.",
      });
    }

    const latest = recentDescending[0];
    if (
      latest &&
      pauseState.isPaused &&
      pauseState.incidentCommitment &&
      pauseState.incidentCommitment !== latest.incidentCommitment
    ) {
      findings.push({
        code: "COMMITMENT_MISMATCH",
        severity: "blocking",
        detail:
          "The latest acknowledgement commits to a different incident than the active pause.",
      });
    }

    return findings;
  }

  private validate(event: PauseAcknowledgementEvent) {
    const { network, contractId } = event;
    if (
      !network ||
      network.length > 32 ||
      !contractId ||
      contractId.length > 128
    ) {
      throw new BadRequestException("Invalid contract identity.");
    }
    if (
      typeof event.sequence !== "string" ||
      !SEQUENCE_PATTERN.test(event.sequence) ||
      BigInt(event.sequence) > MAX_SEQUENCE
    ) {
      throw new BadRequestException("Invalid acknowledgement sequence.");
    }
    if (!Object.values(PauseAcknowledgementActorRole).includes(event.actorRole)) {
      throw new BadRequestException("Unknown acknowledgement actor role.");
    }
    if (!COMMITMENT_PATTERN.test(event.incidentCommitment)) {
      throw new BadRequestException(
        "Incident commitment must be a lowercase SHA-256 hex digest.",
      );
    }
    if (
      !Array.isArray(event.scopes) ||
      event.scopes.length > MAX_SCOPES ||
      event.scopes.some((scope) => !SCOPE_PATTERN.test(scope))
    ) {
      throw new BadRequestException("Invalid acknowledgement scopes.");
    }
    if (!Number.isInteger(event.ledger) || event.ledger < 0) {
      throw new BadRequestException("Invalid ledger.");
    }
    return {
      network,
      contractId,
      sequence: BigInt(event.sequence),
      actorRole: event.actorRole,
      scopes: [...new Set(event.scopes)].sort(),
      incidentCommitment: event.incidentCommitment,
    };
  }
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_ACKNOWLEDGEMENT_PAGE;
  return Math.min(Math.floor(limit), MAX_ACKNOWLEDGEMENT_PAGE);
}

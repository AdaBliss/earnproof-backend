import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ProofActivationAckStatus } from "@prisma/client";
import {
  applyProjectionEventOnce,
  ProjectionEvent,
} from "../contracts/event-projection";
import { PrismaService } from "../database/prisma.service";
import { AuthenticatedUser } from "../auth/auth.types";

export const DEFAULT_EVIDENCE_PAGE = 25;
export const MAX_EVIDENCE_PAGE = 50;
/** A projection not reconciled within this window is reported as stale. */
export const ACTIVATION_PROJECTION_STALE_MS = 10 * 60 * 1000;

const KEY_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const ROLE_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;

export interface ProofActivationAckEvent extends ProjectionEvent {
  proofId: string;
  kind: "REQUIRED" | "COMPLETED";
  requirementKey: string;
  requiredRole: string;
}

export interface ActivationEvidenceDto {
  proofId: string;
  projection: {
    state: "FRESH" | "STALE" | "UNAVAILABLE";
    observedLedger: number | null;
    lastReconciledAt: string | null;
    staleAfterSeconds: number;
  };
  summary: { required: number; completed: number; pending: number };
  /**
   * True or false only when the projection is fresh; null when freshness cannot
   * back the answer. Evidence about acknowledgements, not a validity verdict.
   */
  allRequiredAcknowledged: boolean | null;
  acknowledgements: Array<{
    requirementKey: string;
    requiredRole: string;
    status: ProofActivationAckStatus;
    completedAt: string | null;
    completedLedger: number | null;
  }>;
  truncated: boolean;
  /** Always false: this projection is evidence, never the source of truth. */
  authoritative: false;
  /** Always NOT_DETERMINED: validity is decided by verification, not here. */
  proofValidity: "NOT_DETERMINED";
}

@Injectable()
export class ProofActivationAckService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Projects one acknowledgement event for a proof. Idempotent per event id.
   *
   * A completion is never downgraded by a late or replayed "required" event,
   * and this method never writes to the proof itself.
   */
  async ingest(
    event: ProofActivationAckEvent,
    now: Date = new Date(),
  ): Promise<boolean> {
    if (!event.proofId || event.proofId.length > 64) {
      throw new BadRequestException("Invalid proof id.");
    }
    if (event.kind !== "REQUIRED" && event.kind !== "COMPLETED") {
      throw new BadRequestException("Unknown acknowledgement event kind.");
    }
    if (!KEY_PATTERN.test(event.requirementKey) || !ROLE_PATTERN.test(event.requiredRole)) {
      throw new BadRequestException("Invalid acknowledgement requirement.");
    }
    if (!Number.isInteger(event.ledger) || event.ledger < 0) {
      throw new BadRequestException("Invalid ledger.");
    }

    return applyProjectionEventOnce(
      this.prisma,
      `proof-activation:${event.proofId}`,
      event,
      async (tx) => {
        const existing = await tx.proofActivationAcknowledgement.findUnique({
          where: {
            proofId_requirementKey: {
              proofId: event.proofId,
              requirementKey: event.requirementKey,
            },
          },
        });

        if (event.kind === "COMPLETED") {
          const data = {
            status: ProofActivationAckStatus.COMPLETED,
            completedLedger: event.ledger,
            completedAt: now,
            eventId: event.id,
          };
          if (existing) {
            if (existing.status === ProofActivationAckStatus.COMPLETED) return;
            await tx.proofActivationAcknowledgement.update({
              where: { id: existing.id },
              data,
            });
          } else {
            await tx.proofActivationAcknowledgement.create({
              data: {
                proofId: event.proofId,
                requirementKey: event.requirementKey,
                requiredRole: event.requiredRole,
                ...data,
              },
            });
          }
        } else if (!existing) {
          await tx.proofActivationAcknowledgement.create({
            data: {
              proofId: event.proofId,
              requirementKey: event.requirementKey,
              requiredRole: event.requiredRole,
              status: ProofActivationAckStatus.REQUIRED,
              requiredLedger: event.ledger,
            },
          });
        }

        const projection = await tx.proofActivationProjection.findUnique({
          where: { proofId: event.proofId },
        });
        await tx.proofActivationProjection.upsert({
          where: { proofId: event.proofId },
          create: {
            proofId: event.proofId,
            observedLedger: event.ledger,
            lastReconciledAt: now,
          },
          update: {
            observedLedger: Math.max(projection?.observedLedger ?? 0, event.ledger),
            lastReconciledAt: now,
          },
        });
      },
    );
  }

  /**
   * Bounded acknowledgement evidence for a proof the caller owns (or any proof
   * for an administrator). Unknown and foreign proofs are indistinguishable.
   */
  async getEvidence(
    user: AuthenticatedUser,
    proofId: string,
    limit: number = DEFAULT_EVIDENCE_PAGE,
    now: Date = new Date(),
  ): Promise<ActivationEvidenceDto> {
    const proof = await this.prisma.proof.findUnique({
      where: { id: proofId },
      select: { id: true, userId: true },
    });
    if (!proof || (proof.userId !== user.id && user.role !== "ADMIN")) {
      throw new NotFoundException("Proof not found");
    }

    const pageSize =
      Number.isFinite(limit) && limit >= 1
        ? Math.min(Math.floor(limit), MAX_EVIDENCE_PAGE)
        : DEFAULT_EVIDENCE_PAGE;

    const [rows, groups, projection] = await Promise.all([
      this.prisma.proofActivationAcknowledgement.findMany({
        where: { proofId },
        orderBy: { requirementKey: "asc" },
        take: pageSize,
      }),
      this.prisma.proofActivationAcknowledgement.groupBy({
        by: ["status"],
        where: { proofId },
        _count: { _all: true },
      }),
      this.prisma.proofActivationProjection.findUnique({ where: { proofId } }),
    ]);

    const completed =
      groups.find((g) => g.status === ProofActivationAckStatus.COMPLETED)?._count._all ?? 0;
    const pending =
      groups.find((g) => g.status === ProofActivationAckStatus.REQUIRED)?._count._all ?? 0;
    const required = completed + pending;

    const state: ActivationEvidenceDto["projection"]["state"] = !projection
      ? "UNAVAILABLE"
      : now.getTime() - projection.lastReconciledAt.getTime() >
          ACTIVATION_PROJECTION_STALE_MS
        ? "STALE"
        : "FRESH";

    return {
      proofId,
      projection: {
        state,
        observedLedger: projection?.observedLedger ?? null,
        lastReconciledAt: projection?.lastReconciledAt.toISOString() ?? null,
        staleAfterSeconds: ACTIVATION_PROJECTION_STALE_MS / 1000,
      },
      summary: { required, completed, pending },
      allRequiredAcknowledged:
        state === "FRESH" && required > 0 ? pending === 0 : null,
      acknowledgements: rows.map((row) => ({
        requirementKey: row.requirementKey,
        requiredRole: row.requiredRole,
        status: row.status,
        completedAt: row.completedAt?.toISOString() ?? null,
        completedLedger: row.completedLedger,
      })),
      truncated: required > rows.length,
      authoritative: false,
      proofValidity: "NOT_DETERMINED",
    };
  }
}

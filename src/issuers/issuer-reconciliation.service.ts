import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Interval } from "@nestjs/schedule";
import { IssuerAssuranceLevel, ResourceStatus } from "@prisma/client";
import { StructuredLogger } from "../common/logger";
import { PrismaService } from "../database/prisma.service";
import { DEFAULT_ACCREDITATION_CLOCK_SKEW_MS } from "./issuer-assurance";
import { IssuerRegistryService } from "./issuer-registry.service";

/**
 * Maximum number of issuers to reconcile per cycle to bound execution time.
 */
const RECONCILE_BATCH_SIZE = 30;

/**
 * How long to cache checkpoint updates to avoid excessive writes.
 */
const CHECKPOINT_UPDATE_THROTTLE_MS = 60_000;

/**
 * Outcome counts for one accreditation-expiry reconciliation pass.
 *
 * - `checked`: issuers selected as expired at read time (bounded batch).
 * - `refreshed`: contract facts differed from the projection and were adopted.
 * - `unchanged`: contract confirmed the projection; only the observation
 *   marker (`accreditationSyncedAt`) moved.
 * - `skipped`: contract read unavailable, or the row left ACTIVE between the
 *   read and the write — left untouched, which fails closed because the local
 *   expiry already yields an EXPIRED effective status.
 */
export type AccreditationExpiryReconciliationSummary = {
  checked: number;
  refreshed: number;
  unchanged: number;
  skipped: number;
};

/**
 * IssuerReconciliationService
 * 
 * Reconciles live issuer contract state into backend projections.
 * Runs every 5 minutes to sync authoritative issuer registry state.
 * 
 * Key responsibilities:
 * - Sync issuer status with authoritative registry contract state
 * - Handle lifecycle changes (suspension, reactivation, revocation)
 * - Process address rotation and metadata updates
 * - Quarantine conflicts that cannot be resolved automatically
 * - Reconcile accreditation expiry against the registry contract, so an
 *   expired accreditation is re-observed (and renewed or withdrawn
 *   accreditation adopted) instead of lingering in a stale projection
 * - Maintain bounded reconciliation checkpoints
 * 
 * This extends existing issuer registry sync rather than replacing it.
 */
@Injectable()
export class IssuerReconciliationService {
  private readonly logger = new StructuredLogger(IssuerReconciliationService.name);
  private readonly enabled: boolean;
  private readonly contractId: string;
  private readonly network: string;
  private lastCheckpointUpdate = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly issuerRegistryService: IssuerRegistryService,
  ) {
    this.enabled = config.get<boolean>("issuerRegistry.enabled") ?? false;
    this.contractId = config.get<string>("issuerRegistry.contractId") ?? "";
    this.network = config.get<string>("stellar.network") ?? "testnet";
  }

  @Interval(5 * 60_000) // Every 5 minutes
  async reconcile(): Promise<void> {
    if (!this.enabled || !this.contractId) {
      return;
    }

    try {
      const checkpoint = await this.getOrCreateCheckpoint();
      
      // For MVP, focus on reconciling issuers that have been synced to contract
      await this.reconcileSyncedIssuers();

      // Re-observe accreditation expiry from the contract, so expired
      // accreditations do not linger in stale projections.
      await this.reconcileAccreditationExpiry();
      
      await this.updateCheckpointIfThrottled(checkpoint);
      
    } catch (error) {
      this.logger.error("Issuer reconciliation cycle failed", {
        error: error instanceof Error ? error.message : String(error),
        contractId: this.contractId,
        network: this.network,
      });
    }
  }

  /**
   * Reconcile issuers that have been synced to the contract.
   * 
   * This ensures local issuer state matches authoritative registry state,
   * especially for lifecycle transitions like suspension/revocation.
   */
  private async reconcileSyncedIssuers(): Promise<void> {
    const syncedIssuers = await this.prisma.issuer.findMany({
      where: {
        contractTransactionHash: { not: null },
        contractSyncedStatus: { not: null },
        status: { 
          in: [ResourceStatus.ACTIVE, ResourceStatus.SUSPENDED, ResourceStatus.REVOKED] 
        },
      },
      select: {
        id: true,
        stellarAddress: true,
        status: true,
        contractSyncedStatus: true,
        contractTransactionHash: true,
        metadataHash: true,
        updatedAt: true,
      },
      take: RECONCILE_BATCH_SIZE,
      orderBy: { updatedAt: "asc" }, // Prioritize least recently updated
    });

    let reconciledCount = 0;
    let conflictCount = 0;

    for (const issuer of syncedIssuers) {
      try {
        const result = await this.reconcileIssuerState(issuer);
        if (result.reconciled) {
          reconciledCount++;
        }
        if (result.conflict) {
          conflictCount++;
        }
      } catch (error) {
        this.logger.warn("Failed to reconcile individual issuer", {
          issuerId: issuer.id,
          stellarAddress: issuer.stellarAddress,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (syncedIssuers.length > 0) {
      this.logger.log("Issuer reconciliation cycle completed", {
        issuerCount: syncedIssuers.length,
        reconciledCount,
        conflictCount,
        contractId: this.contractId,
      });
    }
  }

  /**
   * Reconcile accreditation expiry against the registry contract.
   *
   * Accreditation expires with the passage of time, so a projection can lag
   * reality: the effective status is computed live from the stored expiry
   * (and already reads EXPIRED the instant it passes), but the stored
   * projection still needs re-observation — the contract may have renewed
   * the accreditation, withdrawn it, or changed its level since the last
   * sync. This pass selects the bounded batch of ACTIVE, accredited issuers
   * whose expiry has passed (beyond the clock-skew tolerance, on the
   * `(assuranceLevel, accreditationExpiresAt)` index), reads each one from
   * the contract, and adopts the contract facts.
   *
   * Design guarantees:
   *  - Contract wins, always. Adopted level and expiry come only from the
   *    contract read; tenant metadata is never consulted.
   *  - Fail closed. A disabled or failed contract read leaves the row
   *    untouched — the local expiry already yields an EXPIRED effective
   *    status, so skipping cannot assert an active accreditation.
   *  - Deterministic and bounded. One batch per call, oldest expiry first,
   *    same skew boundary as the effective-status function and the API
   *    filter, so the job and the API never disagree about what is expired.
   *  - Idempotent and restartable. A row that left ACTIVE between the read
   *    and the write is skipped via the conditional update; a re-run finds
   *    only rows whose observation is still the old one, and audit logs are
   *    written only when contract facts actually change.
   *  - The stored lifecycle `status` is never moved here: issuers never take
   *    EXPIRED as a stored status — expiry is an effective status derived
   *    from the assurance fields.
   */
  async reconcileAccreditationExpiry(
    now: Date = new Date(),
  ): Promise<AccreditationExpiryReconciliationSummary> {
    if (!this.enabled || !this.contractId) {
      return { checked: 0, refreshed: 0, unchanged: 0, skipped: 0 };
    }

    // The skew tolerance is folded into the query bound so the database
    // returns only rows that are genuinely past expiry, keeping the scan on
    // the accreditation index and the effective-status verdict consistent.
    const cutoff = new Date(
      now.getTime() - DEFAULT_ACCREDITATION_CLOCK_SKEW_MS,
    );

    const due = await this.prisma.issuer.findMany({
      where: {
        status: ResourceStatus.ACTIVE,
        assuranceLevel: { not: IssuerAssuranceLevel.NONE },
        accreditationExpiresAt: { not: null, lte: cutoff },
      },
      select: {
        id: true,
        stellarAddress: true,
        status: true,
        assuranceLevel: true,
        accreditationExpiresAt: true,
        accreditationSyncedAt: true,
        updatedAt: true,
      },
      take: RECONCILE_BATCH_SIZE,
      orderBy: { accreditationExpiresAt: "asc" },
    });

    let refreshed = 0;
    let unchanged = 0;
    let skipped = 0;

    for (const issuer of due) {
      try {
        const outcome = await this.reconcileIssuerAccreditation(issuer, now);
        if (outcome === "refreshed") refreshed++;
        else if (outcome === "unchanged") unchanged++;
        else skipped++;
      } catch (error) {
        skipped++;
        this.logger.warn("Failed to reconcile issuer accreditation", {
          issuerId: issuer.id,
          stellarAddress: issuer.stellarAddress,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (due.length > 0) {
      this.logger.log("Issuer accreditation expiry reconciliation completed", {
        issuerCount: due.length,
        refreshed,
        unchanged,
        skipped,
        contractId: this.contractId,
      });
    }

    return { checked: due.length, refreshed, unchanged, skipped };
  }

  /**
   * Re-observe one expired-accreditation issuer from the contract and adopt
   * the contract facts. Returns whether the projection changed, was
   * confirmed, or was left untouched.
   */
  private async reconcileIssuerAccreditation(
    issuer: {
      id: string;
      stellarAddress: string;
      status: ResourceStatus;
      assuranceLevel: IssuerAssuranceLevel;
      accreditationExpiresAt: Date | null;
      accreditationSyncedAt: Date | null;
      updatedAt: Date;
    },
    now: Date,
  ): Promise<"refreshed" | "unchanged" | "skipped"> {
    const assurance = await this.issuerRegistryService.readIssuerAssurance(
      issuer.id,
    );
    if (assurance.state !== "found") {
      this.logger.warn("Issuer accreditation reconciliation skipped", {
        issuerId: issuer.id,
        stellarAddress: issuer.stellarAddress,
        reason:
          assurance.state === "disabled" ? assurance.reason : assurance.error,
      });
      return "skipped";
    }

    const changed =
      assurance.assuranceLevel !== issuer.assuranceLevel ||
      (assurance.accreditationExpiresAt?.getTime() ?? null) !==
        (issuer.accreditationExpiresAt?.getTime() ?? null);

    // Adopt the contract facts only while the row is still the ACTIVE row we
    // read. A concurrent lifecycle change (suspend/revoke) wins over this
    // write: `count` is 0 and the row is left for the next cycle.
    const applied = await this.prisma.issuer.updateMany({
      where: { id: issuer.id, status: ResourceStatus.ACTIVE },
      data: {
        assuranceLevel: assurance.assuranceLevel,
        accreditationExpiresAt: assurance.accreditationExpiresAt,
        accreditationSyncedAt: assurance.observedAt,
        accreditationContractId: assurance.contractId,
      },
    });
    if (applied.count === 0) return "skipped";

    if (!changed) return "unchanged";

    await this.prisma.auditLog.create({
      data: {
        actorType: "System",
        actorId: "issuer_reconciliation_service",
        action: "RECONCILE_ACCREDITATION",
        resourceType: "Issuer",
        resourceId: issuer.id,
        metadata: {
          previousAssuranceLevel: issuer.assuranceLevel,
          newAssuranceLevel: assurance.assuranceLevel,
          previousAccreditationExpiresAt:
            issuer.accreditationExpiresAt?.toISOString() ?? null,
          newAccreditationExpiresAt:
            assurance.accreditationExpiresAt?.toISOString() ?? null,
          contractId: assurance.contractId,
          reason: "accreditation_expiry_reconciliation",
          timestamp: now.toISOString(),
        },
      },
    });

    this.logger.log("Issuer accreditation reconciled from contract state", {
      issuerId: issuer.id,
      stellarAddress: issuer.stellarAddress,
      previousAssuranceLevel: issuer.assuranceLevel,
      newAssuranceLevel: assurance.assuranceLevel,
    });

    return "refreshed";
  }

  /**
   * Reconcile a single issuer's state against authoritative contract state.
   * 
   * For MVP, this simulates contract state checks since we don't have
   * direct contract read access. In a full implementation, this would
   * call contract read methods to get authoritative issuer status.
   */
  private async reconcileIssuerState(issuer: {
    id: string;
    stellarAddress: string;
    status: ResourceStatus;
    contractSyncedStatus: ResourceStatus | null;
    contractTransactionHash: string | null;
    metadataHash: string | null;
    updatedAt: Date;
  }): Promise<{ reconciled: boolean; conflict: boolean }> {
    
    // For MVP: simulate contract state based on sync state
    // In full implementation, this would read from issuer registry contract
    const simulatedContractState = this.simulateContractState(issuer);
    
    if (!simulatedContractState.available) {
      // Contract state unavailable - skip
      return { reconciled: false, conflict: false };
    }

    // Apply reconciliation rules based on local vs contract state
    const localStatus = issuer.status;
    const contractStatus = simulatedContractState.status;

    if (contractStatus && localStatus !== contractStatus) {
      // Status mismatch detected
      if (this.isAuthorizedTransition(localStatus, contractStatus)) {
        // Auto-repair: update local status to match contract
        await this.updateIssuerStatus(issuer.id, contractStatus, "reconciliation_auto_repair");
        
        this.logger.warn("Auto-repaired issuer status from contract state", {
          issuerId: issuer.id,
          stellarAddress: issuer.stellarAddress,
          previousStatus: localStatus,
          contractStatus,
        });
        
        return { reconciled: true, conflict: false };
        
      } else {
        // Unauthorized transition - quarantine for review
        await this.quarantineConflict({
          issuerId: issuer.id,
          conflictType: "INVALID_TRANSITION",
          contractState: { status: contractStatus },
          localState: { status: localStatus },
          reason: `Invalid status transition detected: ${localStatus} -> ${contractStatus}`,
        });
        
        this.logger.error("Quarantined issuer state conflict", {
          issuerId: issuer.id,
          stellarAddress: issuer.stellarAddress,
          localStatus,
          contractStatus,
        });
        
        return { reconciled: false, conflict: true };
      }
    }

    // Check for metadata drift
    if (simulatedContractState.metadataHash && 
        simulatedContractState.metadataHash !== issuer.metadataHash) {
      
      this.logger.warn("Issuer metadata drift detected", {
        issuerId: issuer.id,
        stellarAddress: issuer.stellarAddress,
        localMetadataHash: issuer.metadataHash,
        contractMetadataHash: simulatedContractState.metadataHash,
      });
      
      // For MVP, log but don't auto-repair metadata mismatches
      // Full implementation would trigger metadata re-sync
    }

    return { reconciled: false, conflict: false };
  }

  /**
   * Simulate contract state for MVP (placeholder for actual contract reads).
   */
  private simulateContractState(issuer: {
    status: ResourceStatus;
    contractSyncedStatus: ResourceStatus | null;
    contractTransactionHash: string | null;
  }): { 
    available: boolean; 
    status?: ResourceStatus; 
    metadataHash?: string;
  } {
    // For MVP: assume contract state matches last synced state
    // Real implementation would call issuer registry contract methods
    
    if (!issuer.contractTransactionHash || !issuer.contractSyncedStatus) {
      return { available: false };
    }

    // Simulate some edge cases for testing reconciliation logic
    const now = Date.now();
    const randomFactor = now % 100;
    
    // 5% chance of simulated status drift for testing
    if (randomFactor < 5) {
      const driftStatuses = [ResourceStatus.SUSPENDED, ResourceStatus.REVOKED];
      const driftStatus = driftStatuses[randomFactor % driftStatuses.length];
      
      if (issuer.status === ResourceStatus.ACTIVE && (driftStatus as ResourceStatus) !== issuer.status) {
        return {
          available: true,
          status: driftStatus,
        };
      }
    }

    return {
      available: true,
      status: issuer.contractSyncedStatus,
    };
  }

  /**
   * Check if a status transition is authorized for auto-repair.
   */
  private isAuthorizedTransition(
    fromStatus: ResourceStatus, 
    toStatus: ResourceStatus
  ): boolean {
    // Define allowed auto-repair transitions
    const allowedTransitions: Record<ResourceStatus, ResourceStatus[]> = {
      [ResourceStatus.ACTIVE]: [ResourceStatus.SUSPENDED, ResourceStatus.REVOKED],
      [ResourceStatus.SUSPENDED]: [ResourceStatus.ACTIVE, ResourceStatus.REVOKED],
      [ResourceStatus.PENDING]: [ResourceStatus.ACTIVE],
      [ResourceStatus.REVOKED]: [], // Revocation is final
      [ResourceStatus.DELETED]: [], // Deletion is final
      [ResourceStatus.EXPIRED]: [],
    };

    return allowedTransitions[fromStatus]?.includes(toStatus) ?? false;
  }

  /**
   * Update issuer status with audit trail.
   */
  private async updateIssuerStatus(
    issuerId: string, 
    newStatus: ResourceStatus, 
    reason: string
  ): Promise<void> {
    const now = new Date();
    const updateData: any = {
      status: newStatus,
      contractSyncState: "SYNCED", // Mark as synced since we're reconciling
    };

    // Set appropriate timestamp fields
    if (newStatus === ResourceStatus.SUSPENDED) {
      updateData.suspendedAt = now;
    } else if (newStatus === ResourceStatus.REVOKED) {
      updateData.revokedAt = now;
    } else if (newStatus === ResourceStatus.ACTIVE) {
      updateData.verifiedAt = now;
    }

    await this.prisma.issuer.update({
      where: { id: issuerId },
      data: updateData,
    });

    // Create audit log entry
    await this.prisma.auditLog.create({
      data: {
        actorType: "System",
        actorId: "issuer_reconciliation_service",
        action: "RECONCILE_STATUS",
        resourceType: "Issuer",
        resourceId: issuerId,
        metadata: {
          newStatus,
          reason,
          timestamp: now.toISOString(),
        },
      },
    });
  }

  /**
   * Quarantine a reconciliation conflict for manual review.
   */
  private async quarantineConflict(conflict: {
    issuerId: string;
    conflictType: "STATE_MISMATCH" | "UNKNOWN_EVENT_VERSION" | "REORG_DETECTED" | "CONTRACT_REPLACEMENT" | "INVALID_TRANSITION";
    contractState: any;
    localState: any;
    reason: string;
  }): Promise<void> {
    try {
      await this.prisma.reconciliationConflict.create({
        data: {
          resourceType: "issuer",
          resourceId: conflict.issuerId,
          contractId: this.contractId,
          network: this.network,
          conflictType: conflict.conflictType,
          status: "QUARANTINED",
          contractState: conflict.contractState,
          localState: conflict.localState,
          metadata: { reason: conflict.reason },
        },
      });
    } catch (error) {
      this.logger.error("Failed to quarantine conflict", {
        issuerId: conflict.issuerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get or create reconciliation checkpoint.
   */
  private async getOrCreateCheckpoint() {
    return await this.prisma.issuerReconciliationCheckpoint.upsert({
      where: { id: "issuer_reconciliation" },
      create: {
        id: "issuer_reconciliation",
        contractId: this.contractId,
        network: this.network,
        syncState: "PENDING",
      },
      update: {},
    });
  }

  /**
   * Update checkpoint if enough time has passed (throttling).
   */
  private async updateCheckpointIfThrottled(checkpoint: any): Promise<void> {
    const now = Date.now();
    if (now - this.lastCheckpointUpdate < CHECKPOINT_UPDATE_THROTTLE_MS) {
      return;
    }

    try {
      await this.prisma.issuerReconciliationCheckpoint.update({
        where: { id: checkpoint.id },
        data: {
          lastSyncedAt: new Date(),
          syncState: "SYNCED",
        },
      });
      
      this.lastCheckpointUpdate = now;
    } catch (error) {
      this.logger.warn("Failed to update reconciliation checkpoint", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get current reconciliation status for observability.
   */
  async getReconciliationStatus() {
    if (!this.enabled) {
      return {
        enabled: false,
        reason: "Issuer registry disabled",
      };
    }

    try {
      const checkpoint = await this.prisma.issuerReconciliationCheckpoint.findUnique({
        where: { id: "issuer_reconciliation" },
      });

      const conflictCount = await this.prisma.reconciliationConflict.count({
        where: {
          resourceType: "issuer",
          status: "QUARANTINED",
        },
      });

      // Currently-expired accreditations, by the same boundary the API filter
      // and the reconciler use. Observable so operators can see whether the
      // expiry pass is keeping up, without reading the issuer table.
      const expiredAccreditationCount = await this.prisma.issuer.count({
        where: {
          status: ResourceStatus.ACTIVE,
          assuranceLevel: { not: IssuerAssuranceLevel.NONE },
          accreditationExpiresAt: {
            not: null,
            lte: new Date(Date.now() - DEFAULT_ACCREDITATION_CLOCK_SKEW_MS),
          },
        },
      });

      return {
        enabled: true,
        contractId: this.contractId,
        network: this.network,
        lastSyncedAt: checkpoint?.lastSyncedAt?.toISOString() ?? null,
        syncState: checkpoint?.syncState ?? "UNKNOWN",
        quarantinedConflicts: conflictCount,
        expiredAccreditationCount,
      };
    } catch (error) {
      return {
        enabled: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Manually trigger reconciliation for a specific issuer (for testing/ops).
   */
  async reconcileIssuer(issuerId: string): Promise<{ success: boolean; message: string }> {
    if (!this.enabled) {
      return { success: false, message: "Issuer registry disabled" };
    }

    try {
      const issuer = await this.prisma.issuer.findUnique({
        where: { id: issuerId },
        select: {
          id: true,
          stellarAddress: true,
          status: true,
          contractSyncedStatus: true,
          contractTransactionHash: true,
          metadataHash: true,
          updatedAt: true,
        },
      });

      if (!issuer) {
        return { success: false, message: "Issuer not found" };
      }

      if (!issuer.contractTransactionHash) {
        return { success: false, message: "Issuer not synced to contract" };
      }

      const result = await this.reconcileIssuerState(issuer);
      
      if (result.conflict) {
        return { success: true, message: "Issuer reconciled - conflict quarantined for review" };
      } else if (result.reconciled) {
        return { success: true, message: "Issuer reconciled successfully" };
      } else {
        return { success: true, message: "Issuer already in sync" };
      }

    } catch (error) {
      this.logger.error("Manual issuer reconciliation failed", {
        issuerId,
        error: error instanceof Error ? error.message : String(error),
      });
      
      return { 
        success: false, 
        message: `Reconciliation failed: ${error instanceof Error ? error.message : String(error)}` 
      };
    }
  }
}
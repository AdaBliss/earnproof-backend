import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  IssuerKeyCompromiseIncident,
  IssuerKeyCompromiseIncidentState,
  IssuerKeyLifecycleState,
  SecurityNotificationSeverity,
  SecurityNotificationType,
} from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { StructuredLogger } from "../common/logger";
import { canonicalize } from "../common/crypto/canonicalize";
import { sha256 } from "../common/crypto/hash";
import { SecurityNotificationService } from "../notifications/security-notification.service";
import {
  KEY_COMPROMISE_LIST_MAX_LIMIT,
  KEY_COMPROMISE_NOTE_MAX_LENGTH,
  KeyCompromiseIncidentResponseDto,
  ListKeyCompromiseIncidentsDto,
} from "./dto/issuer-key-compromise.dto";

/**
 * Bounded discovery: at most this many records are read from any single
 * source. When a source hits the cap the incident records truncated=true
 * and the counts are lower bounds, not exact totals.
 */
export const MAX_DISCOVERY_RECORDS = 500;

/** Maximum policy-commitment rows consulted when counting affected proofs. */
const MAX_POLICY_COMMITMENTS_PER_DISCOVERY = 100;

/** Maximum OPEN incidents the containment job processes in one run. */
export const MAX_OPEN_INCIDENTS_PER_RUN = 10;

export interface RespondToCompromiseInput {
  issuerId: string;
  keyId: string;
  actorId: string;
  /** Caller's organization; when present the issuer must belong to it. */
  organizationId?: string;
  reason: string;
}

export interface ResolveIncidentInput {
  incidentId: string;
  actorId: string;
  /** Caller's organization; when present the issuer must belong to it. */
  organizationId?: string;
  note: string;
}

export interface AffectedRecordsDiscovery {
  /** ACTIVE trust pins currently trusting this key. */
  activeTrustPins: number;
  /** Already-quarantined credentials filed under this keyId. */
  quarantinedCredentials: number;
  /** Proofs whose issuer policy snapshot names this keyId. */
  affectedProofs: number;
  /** True when any source hit its bounded cap. */
  truncated: boolean;
}

export interface ProcessOpenIncidentsResult {
  examined: number;
  contained: number;
  skipped: number;
}

/**
 * Minimal structural view of the Prisma delegates discovery needs, so the
 * same code runs against the live client and inside a transaction.
 */
interface DiscoveryClient {
  credentialVerificationKeyTrustPin: {
    findMany(args: any): Promise<{ id: string }[]>;
  };
  credentialQuarantine: {
    findMany(args: any): Promise<{ id: string }[]>;
  };
  issuerPolicyCommitment: {
    findMany(args: any): Promise<{ id: string }[]>;
  };
  proof: {
    count(args: any): Promise<number>;
  };
}

/**
 * Coordinated response to a compromised issuer signing key (#388).
 *
 * A compromise report is an authorized incident, not just a flag flip:
 *
 * 1. The key transitions to COMPROMISED exactly once. Re-reporting the same
 *    key returns the existing incident without rewriting `compromisedAt`,
 *    so a compromised key can never be silently restored.
 * 2. Every ACTIVE trust pin for the key is revoked. That is what makes the
 *    compromised key fail verification policy: `isKeyTrusted` only trusts
 *    ACTIVE pins, and no new pin can be created for a compromised key.
 * 3. Affected records are discovered (bounded): trust pins, quarantined
 *    credentials, and proofs whose issuer policy snapshot names the key.
 * 4. The issuer organization is notified (best-effort; a delivery failure
 *    never rolls back the containment) and every step is audit-logged.
 * 5. A scheduled job drives OPEN incidents to CONTAINED once discovery is
 *    re-verified and a deterministic evidence hash is recorded; an
 *    authorized operator then resolves the incident with a recovery note.
 *
 * Nothing here writes to the chain and no key material is ever logged,
 * stored, or returned — only public identifiers (issuerId, keyId) and
 * hashes.
 */
@Injectable()
export class IssuerKeyCompromiseResponseService {
  private readonly logger = new StructuredLogger(
    IssuerKeyCompromiseResponseService.name,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: SecurityNotificationService,
  ) {}

  /**
   * Report a compromised issuer signing key and run the coordinated
   * response. Idempotent per (issuerId, keyId): a repeat report returns
   * the existing incident unchanged.
   */
  async respondToCompromise(
    input: RespondToCompromiseInput,
  ): Promise<KeyCompromiseIncidentResponseDto> {
    const actorId = this.requireActor(input.actorId);
    const reason = this.requireNote(input.reason, "reason");

    const issuer = await this.prisma.issuer.findUnique({
      where: { id: input.issuerId },
    });
    if (!issuer) {
      throw new NotFoundException(
        `Issuer with ID "${input.issuerId}" not found`,
      );
    }
    this.assertOrganization(issuer.organizationId, input.organizationId);

    const key = await this.prisma.issuerSigningKey.findUnique({
      where: {
        issuerId_keyId: { issuerId: input.issuerId, keyId: input.keyId },
      },
    });
    if (!key) {
      throw new NotFoundException(
        `Signing key "${input.keyId}" not found for issuer "${input.issuerId}"`,
      );
    }

    if (key.state === IssuerKeyLifecycleState.REVOKED) {
      throw new ConflictException(
        `Signing key "${input.keyId}" is already REVOKED; it is terminal and cannot be reported compromised`,
      );
    }

    // Idempotent re-report: the first compromise stands. Never rewrite
    // compromisedAt, never re-revoke, never re-notify.
    const existing = await this.prisma.issuerKeyCompromiseIncident.findUnique({
      where: {
        issuerId_keyId: { issuerId: input.issuerId, keyId: input.keyId },
      },
    });
    if (existing) {
      this.logger.log("Duplicate compromise report ignored", {
        workflow: "issuer_key_compromise",
        outcome: "duplicate",
        issuerId: input.issuerId,
        keyId: input.keyId,
        incidentId: existing.id,
      });
      return this.toResponseDto(existing);
    }

    const now = new Date();
    const compromisedAt = key.compromisedAt ?? now;

    const incident = await this.prisma.$transaction(async (tx) => {
      // Transition the key exactly once. A key that is already COMPROMISED
      // (for example, flagged before incidents existed) keeps its original
      // compromisedAt.
      if (key.state !== IssuerKeyLifecycleState.COMPROMISED) {
        await tx.issuerSigningKey.update({
          where: { id: key.id },
          data: {
            state: IssuerKeyLifecycleState.COMPROMISED,
            compromisedAt: now,
          },
        });
      }

      // Discover affected records before revoking, so the incident records
      // how many pins were trusting the key at report time.
      const discovery = await this.discoverAffectedRecords(
        tx as unknown as DiscoveryClient,
        input.issuerId,
        input.keyId,
      );

      // Revoke every ACTIVE trust pin for the key. This is the step that
      // makes verification policy fail the key immediately.
      const revoked = await tx.credentialVerificationKeyTrustPin.updateMany({
        where: {
          issuerId: input.issuerId,
          keyId: input.keyId,
          status: "ACTIVE",
        },
        data: {
          status: "REVOKED",
          revokedAt: now,
          revokedBy: actorId,
          revocationReason: "Issuer signing key compromised",
          revision: { increment: 1 },
        },
      });

      const created = await tx.issuerKeyCompromiseIncident.create({
        data: {
          issuerId: input.issuerId,
          signingKeyId: key.id,
          keyId: input.keyId,
          state: IssuerKeyCompromiseIncidentState.OPEN,
          reason,
          reportedByUserId: actorId,
          compromisedAt,
          commitmentHash: key.commitmentHash,
          trustPinsRevoked: revoked.count,
          affectedQuarantines: discovery.quarantinedCredentials,
          affectedProofs: discovery.affectedProofs,
          discoveryTruncated: discovery.truncated,
        },
      });

      await tx.auditLog.create({
        data: {
          actorType: "user",
          actorId,
          action: "issuer.signing_key.compromised",
          resourceType: "issuer_signing_key",
          resourceId: key.id,
          metadata: {
            issuerId: input.issuerId,
            keyId: input.keyId,
            incidentId: created.id,
            trustPinsRevoked: revoked.count,
            affectedQuarantines: discovery.quarantinedCredentials,
            affectedProofs: discovery.affectedProofs,
            discoveryTruncated: discovery.truncated,
          },
        },
      });

      return created;
    });

    // Notify the issuer organization. Best-effort: a notification failure
    // (for example, an inactive organization) must never roll back the
    // containment that just committed.
    const notificationId = await this.notifyOrganization(
      issuer.organizationId,
      incident,
    );
    if (notificationId) {
      await this.prisma.issuerKeyCompromiseIncident.update({
        where: { id: incident.id },
        data: { notificationId },
      });
      incident.notificationId = notificationId;
    }

    this.logger.log("Issuer signing key compromise response recorded", {
      workflow: "issuer_key_compromise",
      outcome: "reported",
      issuerId: input.issuerId,
      keyId: input.keyId,
      incidentId: incident.id,
      trustPinsRevoked: incident.trustPinsRevoked,
    });

    return this.toResponseDto(incident);
  }

  /**
   * Get the incident for one signing key, if any.
   */
  async getIncident(
    issuerId: string,
    keyId: string,
    organizationId?: string,
  ): Promise<KeyCompromiseIncidentResponseDto> {
    const issuer = await this.prisma.issuer.findUnique({
      where: { id: issuerId },
    });
    if (!issuer) {
      throw new NotFoundException(`Issuer with ID "${issuerId}" not found`);
    }
    this.assertOrganization(issuer.organizationId, organizationId);

    const incident = await this.prisma.issuerKeyCompromiseIncident.findUnique({
      where: { issuerId_keyId: { issuerId, keyId } },
    });
    if (!incident) {
      throw new NotFoundException(
        `No compromise incident found for signing key "${keyId}"`,
      );
    }
    return this.toResponseDto(incident);
  }

  /**
   * List incidents for an issuer, newest first. Bounded: at most 100 rows.
   */
  async listIncidents(
    issuerId: string,
    organizationId: string | undefined,
    query: ListKeyCompromiseIncidentsDto = {},
  ): Promise<KeyCompromiseIncidentResponseDto[]> {
    const issuer = await this.prisma.issuer.findUnique({
      where: { id: issuerId },
    });
    if (!issuer) {
      throw new NotFoundException(`Issuer with ID "${issuerId}" not found`);
    }
    this.assertOrganization(issuer.organizationId, organizationId);

    const limit = Math.min(
      Math.max(query.limit ?? 20, 1),
      KEY_COMPROMISE_LIST_MAX_LIMIT,
    );

    const incidents = await this.prisma.issuerKeyCompromiseIncident.findMany({
      where: {
        issuerId,
        ...(query.state ? { state: query.state } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return incidents.map((i) => this.toResponseDto(i));
  }

  /**
   * Resolve a contained incident with a recovery note. Only CONTAINED
   * incidents can be resolved: an OPEN incident must first be driven to
   * CONTAINED by the job, so resolution always carries containment
   * evidence.
   */
  async resolveIncident(
    input: ResolveIncidentInput,
  ): Promise<KeyCompromiseIncidentResponseDto> {
    const actorId = this.requireActor(input.actorId);
    const note = this.requireNote(input.note, "note");

    const incident = await this.prisma.issuerKeyCompromiseIncident.findUnique({
      where: { id: input.incidentId },
    });
    if (!incident) {
      throw new NotFoundException(
        `Compromise incident "${input.incidentId}" not found`,
      );
    }

    const issuer = await this.prisma.issuer.findUnique({
      where: { id: incident.issuerId },
    });
    if (!issuer) {
      throw new NotFoundException(
        `Issuer with ID "${incident.issuerId}" not found`,
      );
    }
    this.assertOrganization(issuer.organizationId, input.organizationId);

    if (incident.state !== IssuerKeyCompromiseIncidentState.CONTAINED) {
      throw new BadRequestException(
        `Only CONTAINED incidents can be resolved; current state: ${incident.state}`,
      );
    }

    const resolved = await this.prisma.issuerKeyCompromiseIncident.update({
      where: { id: incident.id },
      data: {
        state: IssuerKeyCompromiseIncidentState.RESOLVED,
        resolvedAt: new Date(),
        resolvedByUserId: actorId,
        resolutionNote: note,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorType: "user",
        actorId,
        action: "issuer.signing_key.compromise.resolved",
        resourceType: "issuer_signing_key",
        resourceId: incident.signingKeyId,
        metadata: {
          issuerId: incident.issuerId,
          keyId: incident.keyId,
          incidentId: incident.id,
          evidenceHash: incident.evidenceHash,
        },
      },
    });

    return this.toResponseDto(resolved);
  }

  /**
   * Discover records affected by a compromised key, bounded per source.
   * Counts only; nothing is mutated here.
   */
  async discoverAffectedRecords(
    client: DiscoveryClient,
    issuerId: string,
    keyId: string,
  ): Promise<AffectedRecordsDiscovery> {
    // take cap+1 so hitting the cap is detectable without a second query.
    const cap = MAX_DISCOVERY_RECORDS + 1;

    const pins = await client.credentialVerificationKeyTrustPin.findMany({
      where: { issuerId, keyId, status: "ACTIVE" },
      select: { id: true },
      take: cap,
    });

    const quarantines = await client.credentialQuarantine.findMany({
      where: { keyId, state: "QUARANTINED" },
      select: { id: true },
      take: cap,
    });

    // Proofs link to the key through the issuer policy snapshot captured
    // at issuance: the snapshot's signingKeyVersionId names the key.
    const commitments = await client.issuerPolicyCommitment.findMany({
      where: {
        issuerId,
        policySnapshot: { path: ["signingKeyVersionId"], equals: keyId },
      },
      select: { id: true },
      take: MAX_POLICY_COMMITMENTS_PER_DISCOVERY,
    });

    let affectedProofs = 0;
    if (commitments.length > 0) {
      affectedProofs = await client.proof.count({
        where: {
          issuerPolicyCommitmentId: { in: commitments.map((c) => c.id) },
        },
      });
    }

    const truncated =
      pins.length > MAX_DISCOVERY_RECORDS ||
      quarantines.length > MAX_DISCOVERY_RECORDS ||
      commitments.length >= MAX_POLICY_COMMITMENTS_PER_DISCOVERY;

    return {
      activeTrustPins: Math.min(pins.length, MAX_DISCOVERY_RECORDS),
      quarantinedCredentials: Math.min(
        quarantines.length,
        MAX_DISCOVERY_RECORDS,
      ),
      affectedProofs,
      truncated,
    };
  }

  /**
   * Drive OPEN incidents toward CONTAINED. Called by the scheduled job;
   * safe to run concurrently and repeatedly (idempotent per incident).
   */
  async processOpenIncidents(
    limit: number = MAX_OPEN_INCIDENTS_PER_RUN,
  ): Promise<ProcessOpenIncidentsResult> {
    const take = Math.min(Math.max(limit, 1), MAX_OPEN_INCIDENTS_PER_RUN);

    const incidents = await this.prisma.issuerKeyCompromiseIncident.findMany({
      where: { state: IssuerKeyCompromiseIncidentState.OPEN },
      orderBy: { createdAt: "asc" },
      take,
    });

    let contained = 0;
    let skipped = 0;
    for (const incident of incidents) {
      try {
        const done = await this.containIncident(incident);
        if (done) contained++;
        else skipped++;
      } catch (error) {
        this.logger.error("Failed to contain key compromise incident", {
          workflow: "issuer_key_compromise",
          outcome: "contain_failed",
          incidentId: incident.id,
          error: error instanceof Error ? error.message : String(error),
        });
        skipped++;
      }
    }

    return { examined: incidents.length, contained, skipped };
  }

  /**
   * Contain one OPEN incident: re-run discovery, revoke any straggler
   * pins, verify the key is still COMPROMISED with an unchanged
   * commitment, and record the deterministic evidence hash.
   *
   * Returns false (leaving the incident OPEN) when the local state no
   * longer matches the incident — for example, the key is no longer
   * COMPROMISED or its commitment drifted. Those cases need operator
   * review, never silent auto-resolution.
   */
  private async containIncident(
    incident: IssuerKeyCompromiseIncident,
  ): Promise<boolean> {
    const key = await this.prisma.issuerSigningKey.findUnique({
      where: { id: incident.signingKeyId },
    });
    if (!key) {
      this.logger.error("Compromise incident references a missing key", {
        workflow: "issuer_key_compromise",
        outcome: "contain_skipped",
        incidentId: incident.id,
        signingKeyId: incident.signingKeyId,
      });
      return false;
    }

    if (key.state !== IssuerKeyLifecycleState.COMPROMISED) {
      this.logger.error(
        "Compromise incident key is no longer COMPROMISED; leaving OPEN for operator review",
        {
          workflow: "issuer_key_compromise",
          outcome: "contain_skipped",
          incidentId: incident.id,
          keyId: incident.keyId,
          keyState: key.state,
        },
      );
      return false;
    }

    if (key.commitmentHash !== incident.commitmentHash) {
      this.logger.error(
        "Compromise incident key commitment drifted; leaving OPEN for operator review",
        {
          workflow: "issuer_key_compromise",
          outcome: "contain_skipped",
          incidentId: incident.id,
          keyId: incident.keyId,
        },
      );
      return false;
    }

    const discovery = await this.discoverAffectedRecords(
      this.prisma as unknown as DiscoveryClient,
      incident.issuerId,
      incident.keyId,
    );

    // Defense in depth: revoke any ACTIVE pin that appeared after the
    // report (pin creation for compromised keys is blocked, but a pin
    // created in the race window must not survive containment).
    const stragglers =
      await this.prisma.credentialVerificationKeyTrustPin.updateMany({
        where: {
          issuerId: incident.issuerId,
          keyId: incident.keyId,
          status: "ACTIVE",
        },
        data: {
          status: "REVOKED",
          revokedAt: new Date(),
          revokedBy: "system:issuer-key-compromise",
          revocationReason: "Issuer signing key compromised",
          revision: { increment: 1 },
        },
      });

    const trustPinsRevoked = incident.trustPinsRevoked + stragglers.count;
    const now = new Date();
    const evidenceHash = computeEvidenceHash({
      incidentId: incident.id,
      issuerId: incident.issuerId,
      keyId: incident.keyId,
      compromisedAt: incident.compromisedAt.toISOString(),
      commitmentHash: incident.commitmentHash,
      trustPinsRevoked,
      affectedQuarantines: discovery.quarantinedCredentials,
      affectedProofs: discovery.affectedProofs,
    });

    // Contract reconciliation evidence, stated honestly: this job does not
    // perform an on-chain read. It records the last contract confirmation
    // on file for the key, if any; otherwise the incident keeps
    // contractReconciledAt null so nobody mistakes containment for an
    // on-chain check.
    const contractReconciledAt = key.contractSyncedAt ?? null;
    const contractReconciliationNote = key.contractSyncedAt
      ? `Key commitment last confirmed against the contract at ${key.contractSyncedAt.toISOString()}.`
      : "No contract sync on record for this key; on-chain commitment not re-verified by containment.";

    const contained = await this.prisma.issuerKeyCompromiseIncident.update({
      where: { id: incident.id },
      data: {
        state: IssuerKeyCompromiseIncidentState.CONTAINED,
        trustPinsRevoked,
        affectedQuarantines: discovery.quarantinedCredentials,
        affectedProofs: discovery.affectedProofs,
        discoveryTruncated: discovery.truncated,
        evidenceHash,
        containedAt: now,
        contractReconciledAt,
        contractReconciliationNote,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorType: "system",
        actorId: "system:issuer-key-compromise",
        action: "issuer.signing_key.compromise.contained",
        resourceType: "issuer_signing_key",
        resourceId: incident.signingKeyId,
        metadata: {
          issuerId: incident.issuerId,
          keyId: incident.keyId,
          incidentId: incident.id,
          trustPinsRevoked,
          affectedQuarantines: discovery.quarantinedCredentials,
          affectedProofs: discovery.affectedProofs,
          discoveryTruncated: discovery.truncated,
          evidenceHash,
        },
      },
    });

    this.logger.log("Issuer signing key compromise incident contained", {
      workflow: "issuer_key_compromise",
      outcome: "contained",
      incidentId: incident.id,
      keyId: incident.keyId,
      trustPinsRevoked,
      evidenceHash,
    });

    return !!contained;
  }

  /**
   * Notify the issuer organization about the compromise. Returns the
   * notification id, or null when delivery failed (logged, never thrown).
   */
  private async notifyOrganization(
    organizationId: string,
    incident: IssuerKeyCompromiseIncident,
  ): Promise<string | null> {
    try {
      const record = await this.notifications.createNotification(
        organizationId,
        {
          type: SecurityNotificationType.ISSUER_SIGNING_KEY_COMPROMISED,
          severity: SecurityNotificationSeverity.CRITICAL,
          title: "Issuer signing key compromised",
          summary:
            `Signing key ${incident.keyId} for issuer ${incident.issuerId} was marked compromised. ` +
            `${incident.trustPinsRevoked} trust pin(s) revoked; ` +
            `${incident.affectedQuarantines} quarantined credential(s) and ` +
            `${incident.affectedProofs} proof(s) found affected.`,
          data: {
            issuerId: incident.issuerId,
            keyId: incident.keyId,
            incidentId: incident.id,
            compromisedAt: incident.compromisedAt.toISOString(),
            trustPinsRevoked: incident.trustPinsRevoked,
            affectedQuarantines: incident.affectedQuarantines,
            affectedProofs: incident.affectedProofs,
          },
          retentionDays: 90,
        },
      );
      return record.id;
    } catch (error) {
      this.logger.error("Failed to notify organization of key compromise", {
        workflow: "issuer_key_compromise",
        outcome: "notification_failed",
        organizationId,
        incidentId: incident.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Organization scoping: a caller scoped to an organization may only act
   * on that organization's issuers. Platform admins (no organization on
   * the session) are not scoped.
   */
  private assertOrganization(
    issuerOrganizationId: string,
    callerOrganizationId?: string,
  ): void {
    if (callerOrganizationId && callerOrganizationId !== issuerOrganizationId) {
      throw new ForbiddenException(
        "Issuer does not belong to the caller's organization",
      );
    }
  }

  private requireActor(actorId: string): string {
    if (!actorId || actorId.trim().length === 0) {
      throw new BadRequestException("An acting user id is required");
    }
    return actorId;
  }

  private requireNote(note: string, field: string): string {
    if (typeof note !== "string" || note.trim().length === 0) {
      throw new BadRequestException(`${field} must not be empty`);
    }
    if (note.length > KEY_COMPROMISE_NOTE_MAX_LENGTH) {
      throw new BadRequestException(
        `${field} exceeds maximum length of ${KEY_COMPROMISE_NOTE_MAX_LENGTH} characters`,
      );
    }
    return note.trim();
  }

  private toResponseDto(
    incident: IssuerKeyCompromiseIncident,
  ): KeyCompromiseIncidentResponseDto {
    return {
      id: incident.id,
      issuerId: incident.issuerId,
      keyId: incident.keyId,
      state: incident.state,
      reason: incident.reason,
      compromisedAt: incident.compromisedAt.toISOString(),
      trustPinsRevoked: incident.trustPinsRevoked,
      affectedQuarantines: incident.affectedQuarantines,
      affectedProofs: incident.affectedProofs,
      discoveryTruncated: incident.discoveryTruncated,
      evidenceHash: incident.evidenceHash,
      containedAt: incident.containedAt?.toISOString() ?? null,
      resolvedAt: incident.resolvedAt?.toISOString() ?? null,
      resolutionNote: incident.resolutionNote,
      notificationId: incident.notificationId,
      contractReconciledAt:
        incident.contractReconciledAt?.toISOString() ?? null,
      createdAt: incident.createdAt.toISOString(),
    };
  }
}

/**
 * Deterministic evidence fingerprint for a contained incident:
 * "sha256:<hex>" of the canonical JSON of the containment facts.
 * Anyone holding the incident can recompute it to verify the evidence.
 */
export function computeEvidenceHash(evidence: {
  incidentId: string;
  issuerId: string;
  keyId: string;
  compromisedAt: string;
  commitmentHash: string;
  trustPinsRevoked: number;
  affectedQuarantines: number;
  affectedProofs: number;
}): string {
  return `sha256:${sha256(canonicalize(evidence))}`;
}

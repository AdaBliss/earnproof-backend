import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import {
  IssuerKeyCompromiseIncidentState,
  IssuerKeyLifecycleState,
  SecurityNotificationSeverity,
  SecurityNotificationType,
} from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { SecurityNotificationService } from "../notifications/security-notification.service";
import {
  IssuerKeyCompromiseResponseService,
  MAX_DISCOVERY_RECORDS,
  MAX_OPEN_INCIDENTS_PER_RUN,
  computeEvidenceHash,
} from "./issuer-key-compromise-response.service";

// Fake, clearly synthetic identifiers. No key material anywhere in this file.
const ISSUER_ID = "issuer-compromise-test-1";
const ORG_ID = "org-compromise-test-1";
const OTHER_ORG_ID = "org-compromise-test-2";
const KEY_ID = "test-key-1";
const ACTOR_ID = "user-compromise-admin-1";
const REASON = "Issuer reported the key may have leaked.";

function makeKey(overrides: Record<string, unknown> = {}) {
  return {
    id: "signing-key-row-1",
    issuerId: ISSUER_ID,
    keyId: KEY_ID,
    publicKey: "ed25519-test-public-key-material",
    commitmentHash: "sha256:test-commitment-hash",
    state: IssuerKeyLifecycleState.ACTIVE,
    activatedAt: new Date("2026-01-01T00:00:00.000Z"),
    retiredAt: null,
    compromisedAt: null,
    revokedAt: null,
    contractSyncedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeIssuer(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUER_ID,
    organizationId: ORG_ID,
    stellarAddress: "GTESTISSUERADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    status: "ACTIVE",
    ...overrides,
  };
}

function makeIncident(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-11-19T12:00:00.000Z");
  return {
    id: "incident-1",
    issuerId: ISSUER_ID,
    signingKeyId: "signing-key-row-1",
    keyId: KEY_ID,
    state: IssuerKeyCompromiseIncidentState.OPEN,
    reason: REASON,
    reportedByUserId: ACTOR_ID,
    compromisedAt: now,
    commitmentHash: "sha256:test-commitment-hash",
    trustPinsRevoked: 2,
    affectedQuarantines: 1,
    affectedProofs: 3,
    discoveryTruncated: false,
    evidenceHash: null,
    containedAt: null,
    resolvedAt: null,
    resolvedByUserId: null,
    resolutionNote: null,
    notificationId: null,
    contractReconciledAt: null,
    contractReconciliationNote: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("IssuerKeyCompromiseResponseService", () => {
  let service: IssuerKeyCompromiseResponseService;
  let prisma: any;
  let notifications: { createNotification: jest.Mock };

  beforeEach(() => {
    prisma = {
      issuer: { findUnique: jest.fn() },
      issuerSigningKey: { findUnique: jest.fn(), update: jest.fn() },
      issuerKeyCompromiseIncident: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      credentialVerificationKeyTrustPin: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
      },
      credentialQuarantine: { findMany: jest.fn() },
      issuerPolicyCommitment: { findMany: jest.fn() },
      proof: { count: jest.fn() },
      auditLog: { create: jest.fn().mockResolvedValue({ id: "audit-1" }) },
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(prisma)),
    };
    notifications = {
      createNotification: jest.fn().mockResolvedValue({ id: "notification-1" }),
    };
    service = new IssuerKeyCompromiseResponseService(
      prisma as unknown as PrismaService,
      notifications as unknown as SecurityNotificationService,
    );
  });

  function arrangeReportableKey(keyOverrides: Record<string, unknown> = {}) {
    prisma.issuer.findUnique.mockResolvedValue(makeIssuer());
    prisma.issuerSigningKey.findUnique.mockResolvedValue(makeKey(keyOverrides));
    prisma.issuerKeyCompromiseIncident.findUnique.mockResolvedValue(null);
    prisma.credentialVerificationKeyTrustPin.findMany.mockResolvedValue([
      { id: "pin-1" },
      { id: "pin-2" },
    ]);
    prisma.credentialVerificationKeyTrustPin.updateMany.mockResolvedValue({
      count: 2,
    });
    prisma.credentialQuarantine.findMany.mockResolvedValue([{ id: "q-1" }]);
    prisma.issuerPolicyCommitment.findMany.mockResolvedValue([
      { id: "commitment-1" },
    ]);
    prisma.proof.count.mockResolvedValue(3);
    prisma.issuerKeyCompromiseIncident.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(makeIncident({ ...data, id: "incident-1" })),
    );
    prisma.issuerKeyCompromiseIncident.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(makeIncident({ ...data, id: "incident-1" })),
    );
  }

  function reportInput(overrides: Record<string, unknown> = {}) {
    return {
      issuerId: ISSUER_ID,
      keyId: KEY_ID,
      actorId: ACTOR_ID,
      organizationId: ORG_ID,
      reason: REASON,
      ...overrides,
    };
  }

  describe("respondToCompromise — positive", () => {
    it("marks an ACTIVE key COMPROMISED and opens an incident with discovery counts", async () => {
      arrangeReportableKey();

      const result = await service.respondToCompromise(reportInput());

      expect(prisma.issuerSigningKey.update).toHaveBeenCalledWith({
        where: { id: "signing-key-row-1" },
        data: {
          state: IssuerKeyLifecycleState.COMPROMISED,
          compromisedAt: expect.any(Date),
        },
      });
      expect(result.state).toBe(IssuerKeyCompromiseIncidentState.OPEN);
      expect(result.keyId).toBe(KEY_ID);
      expect(result.trustPinsRevoked).toBe(2);
      expect(result.affectedQuarantines).toBe(1);
      expect(result.affectedProofs).toBe(3);
      expect(result.discoveryTruncated).toBe(false);
      expect(result.compromisedAt).toBeDefined();
    });

    it("revokes every ACTIVE trust pin for the key", async () => {
      arrangeReportableKey();

      await service.respondToCompromise(reportInput());

      expect(
        prisma.credentialVerificationKeyTrustPin.updateMany,
      ).toHaveBeenCalledWith({
        where: { issuerId: ISSUER_ID, keyId: KEY_ID, status: "ACTIVE" },
        data: expect.objectContaining({
          status: "REVOKED",
          revokedBy: ACTOR_ID,
          revocationReason: "Issuer signing key compromised",
        }),
      });
    });

    it("audit-logs the compromise with ids and counts only", async () => {
      arrangeReportableKey();

      await service.respondToCompromise(reportInput());

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "issuer.signing_key.compromised",
          resourceType: "issuer_signing_key",
          resourceId: "signing-key-row-1",
        }),
      });
      const metadata = prisma.auditLog.create.mock.calls[0][0].data.metadata;
      expect(metadata).toEqual(
        expect.objectContaining({
          issuerId: ISSUER_ID,
          keyId: KEY_ID,
          incidentId: "incident-1",
          trustPinsRevoked: 2,
        }),
      );
      expect(JSON.stringify(metadata)).not.toContain("ed25519-test-public");
    });

    it("notifies the issuer organization as CRITICAL with the new notification type", async () => {
      arrangeReportableKey();

      const result = await service.respondToCompromise(reportInput());

      expect(notifications.createNotification).toHaveBeenCalledWith(
        ORG_ID,
        expect.objectContaining({
          type: SecurityNotificationType.ISSUER_SIGNING_KEY_COMPROMISED,
          severity: SecurityNotificationSeverity.CRITICAL,
        }),
      );
      expect(result.notificationId).toBe("notification-1");
    });

    it("accepts PENDING and RETIRED keys", async () => {
      for (const state of [
        IssuerKeyLifecycleState.PENDING,
        IssuerKeyLifecycleState.RETIRED,
      ]) {
        jest.clearAllMocks();
        arrangeReportableKey({ state });
        const result = await service.respondToCompromise(reportInput());
        expect(result.state).toBe(IssuerKeyCompromiseIncidentState.OPEN);
      }
    });

    it("adopts a legacy COMPROMISED key without rewriting its compromisedAt", async () => {
      const originalCompromisedAt = new Date("2026-11-10T08:00:00.000Z");
      arrangeReportableKey({
        state: IssuerKeyLifecycleState.COMPROMISED,
        compromisedAt: originalCompromisedAt,
      });

      const result = await service.respondToCompromise(reportInput());

      expect(prisma.issuerSigningKey.update).not.toHaveBeenCalled();
      expect(result.compromisedAt).toBe(originalCompromisedAt.toISOString());
    });
  });

  describe("respondToCompromise — idempotency / regression", () => {
    it("returns the existing incident unchanged on a repeat report", async () => {
      const existing = makeIncident({
        compromisedAt: new Date("2026-11-10T08:00:00.000Z"),
      });
      prisma.issuer.findUnique.mockResolvedValue(makeIssuer());
      prisma.issuerSigningKey.findUnique.mockResolvedValue(
        makeKey({
          state: IssuerKeyLifecycleState.COMPROMISED,
          compromisedAt: new Date("2026-11-10T08:00:00.000Z"),
        }),
      );
      prisma.issuerKeyCompromiseIncident.findUnique.mockResolvedValue(existing);

      const result = await service.respondToCompromise(reportInput());

      expect(result.id).toBe("incident-1");
      expect(result.compromisedAt).toBe("2026-11-10T08:00:00.000Z");
      expect(prisma.issuerSigningKey.update).not.toHaveBeenCalled();
      expect(
        prisma.credentialVerificationKeyTrustPin.updateMany,
      ).not.toHaveBeenCalled();
      expect(prisma.issuerKeyCompromiseIncident.create).not.toHaveBeenCalled();
      expect(notifications.createNotification).not.toHaveBeenCalled();
    });

    it("a notification failure does not fail the compromise response", async () => {
      arrangeReportableKey();
      notifications.createNotification.mockRejectedValue(
        new Error("organization not active"),
      );

      const result = await service.respondToCompromise(reportInput());

      expect(result.state).toBe(IssuerKeyCompromiseIncidentState.OPEN);
      expect(result.notificationId).toBeNull();
      expect(prisma.issuerSigningKey.update).toHaveBeenCalled();
    });
  });

  describe("respondToCompromise — negative", () => {
    it("throws NotFoundException for an unknown issuer", async () => {
      prisma.issuer.findUnique.mockResolvedValue(null);

      await expect(service.respondToCompromise(reportInput())).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws NotFoundException for an unknown key", async () => {
      prisma.issuer.findUnique.mockResolvedValue(makeIssuer());
      prisma.issuerSigningKey.findUnique.mockResolvedValue(null);

      await expect(service.respondToCompromise(reportInput())).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws ConflictException for an already REVOKED key", async () => {
      prisma.issuer.findUnique.mockResolvedValue(makeIssuer());
      prisma.issuerSigningKey.findUnique.mockResolvedValue(
        makeKey({ state: IssuerKeyLifecycleState.REVOKED }),
      );

      await expect(service.respondToCompromise(reportInput())).rejects.toThrow(
        ConflictException,
      );
    });

    it("throws BadRequestException for an empty reason", async () => {
      await expect(
        service.respondToCompromise(reportInput({ reason: "   " })),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException for a missing actor", async () => {
      await expect(
        service.respondToCompromise(reportInput({ actorId: "" })),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("respondToCompromise — boundary", () => {
    it("accepts a reason of exactly 1024 characters", async () => {
      arrangeReportableKey();

      const result = await service.respondToCompromise(
        reportInput({ reason: "r".repeat(1024) }),
      );

      expect(result.state).toBe(IssuerKeyCompromiseIncidentState.OPEN);
    });

    it("rejects a reason of 1025 characters", async () => {
      await expect(
        service.respondToCompromise(reportInput({ reason: "r".repeat(1025) })),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("respondToCompromise — authorization", () => {
    it("throws ForbiddenException for a caller from another organization", async () => {
      prisma.issuer.findUnique.mockResolvedValue(makeIssuer());

      await expect(
        service.respondToCompromise(
          reportInput({ organizationId: OTHER_ORG_ID }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it("allows a platform admin with no organization on the session", async () => {
      arrangeReportableKey();

      const result = await service.respondToCompromise(
        reportInput({ organizationId: undefined }),
      );

      expect(result.state).toBe(IssuerKeyCompromiseIncidentState.OPEN);
    });
  });

  describe("discoverAffectedRecords — boundary", () => {
    it("counts pins, quarantines, and proofs", async () => {
      prisma.credentialVerificationKeyTrustPin.findMany.mockResolvedValue([
        { id: "pin-1" },
      ]);
      prisma.credentialQuarantine.findMany.mockResolvedValue([]);
      prisma.issuerPolicyCommitment.findMany.mockResolvedValue([
        { id: "c-1" },
        { id: "c-2" },
      ]);
      prisma.proof.count.mockResolvedValue(7);

      const result = await service.discoverAffectedRecords(
        prisma,
        ISSUER_ID,
        KEY_ID,
      );

      expect(result).toEqual({
        activeTrustPins: 1,
        quarantinedCredentials: 0,
        affectedProofs: 7,
        truncated: false,
      });
      expect(prisma.proof.count).toHaveBeenCalledWith({
        where: { issuerPolicyCommitmentId: { in: ["c-1", "c-2"] } },
      });
    });

    it("flags truncation and caps counts when a source hits the bound", async () => {
      const overCap = Array.from(
        { length: MAX_DISCOVERY_RECORDS + 1 },
        (_, i) => ({ id: `pin-${i}` }),
      );
      prisma.credentialVerificationKeyTrustPin.findMany.mockResolvedValue(
        overCap,
      );
      prisma.credentialQuarantine.findMany.mockResolvedValue([]);
      prisma.issuerPolicyCommitment.findMany.mockResolvedValue([]);
      prisma.proof.count.mockResolvedValue(0);

      const result = await service.discoverAffectedRecords(
        prisma,
        ISSUER_ID,
        KEY_ID,
      );

      expect(result.activeTrustPins).toBe(MAX_DISCOVERY_RECORDS);
      expect(result.truncated).toBe(true);
    });

    it("returns zero proofs without querying proofs when no commitment names the key", async () => {
      prisma.credentialVerificationKeyTrustPin.findMany.mockResolvedValue([]);
      prisma.credentialQuarantine.findMany.mockResolvedValue([]);
      prisma.issuerPolicyCommitment.findMany.mockResolvedValue([]);

      const result = await service.discoverAffectedRecords(
        prisma,
        ISSUER_ID,
        KEY_ID,
      );

      expect(result.affectedProofs).toBe(0);
      expect(prisma.proof.count).not.toHaveBeenCalled();
    });
  });

  describe("getIncident / listIncidents", () => {
    it("returns the incident for a key", async () => {
      prisma.issuer.findUnique.mockResolvedValue(makeIssuer());
      prisma.issuerKeyCompromiseIncident.findUnique.mockResolvedValue(
        makeIncident(),
      );

      const result = await service.getIncident(ISSUER_ID, KEY_ID, ORG_ID);

      expect(result.id).toBe("incident-1");
      expect(result.keyId).toBe(KEY_ID);
    });

    it("throws NotFoundException when no incident exists for the key", async () => {
      prisma.issuer.findUnique.mockResolvedValue(makeIssuer());
      prisma.issuerKeyCompromiseIncident.findUnique.mockResolvedValue(null);

      await expect(
        service.getIncident(ISSUER_ID, KEY_ID, ORG_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws ForbiddenException when listing another organization's issuer", async () => {
      prisma.issuer.findUnique.mockResolvedValue(makeIssuer());

      await expect(
        service.listIncidents(ISSUER_ID, OTHER_ORG_ID),
      ).rejects.toThrow(ForbiddenException);
    });

    it("clamps the list limit to 100", async () => {
      prisma.issuer.findUnique.mockResolvedValue(makeIssuer());
      prisma.issuerKeyCompromiseIncident.findMany.mockResolvedValue([]);

      await service.listIncidents(ISSUER_ID, ORG_ID, { limit: 500 });

      expect(prisma.issuerKeyCompromiseIncident.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });

    it("defaults the list limit to 20", async () => {
      prisma.issuer.findUnique.mockResolvedValue(makeIssuer());
      prisma.issuerKeyCompromiseIncident.findMany.mockResolvedValue([]);

      await service.listIncidents(ISSUER_ID, ORG_ID, {});

      expect(prisma.issuerKeyCompromiseIncident.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 20 }),
      );
    });
  });

  describe("resolveIncident", () => {
    it("resolves a CONTAINED incident with the recovery note", async () => {
      const contained = makeIncident({
        state: IssuerKeyCompromiseIncidentState.CONTAINED,
        evidenceHash: "sha256:test-evidence",
      });
      prisma.issuerKeyCompromiseIncident.findUnique.mockResolvedValue(
        contained,
      );
      prisma.issuer.findUnique.mockResolvedValue(makeIssuer());
      prisma.issuerKeyCompromiseIncident.update.mockResolvedValue(
        makeIncident({
          state: IssuerKeyCompromiseIncidentState.RESOLVED,
          resolutionNote: "Replacement key verified.",
        }),
      );

      const result = await service.resolveIncident({
        incidentId: "incident-1",
        actorId: ACTOR_ID,
        organizationId: ORG_ID,
        note: "Replacement key verified.",
      });

      expect(result.state).toBe(IssuerKeyCompromiseIncidentState.RESOLVED);
      expect(result.resolutionNote).toBe("Replacement key verified.");
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "issuer.signing_key.compromise.resolved",
        }),
      });
    });

    it("throws BadRequestException when resolving an OPEN incident", async () => {
      prisma.issuerKeyCompromiseIncident.findUnique.mockResolvedValue(
        makeIncident({ state: IssuerKeyCompromiseIncidentState.OPEN }),
      );
      prisma.issuer.findUnique.mockResolvedValue(makeIssuer());

      await expect(
        service.resolveIncident({
          incidentId: "incident-1",
          actorId: ACTOR_ID,
          organizationId: ORG_ID,
          note: "Done.",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException for an unknown incident", async () => {
      prisma.issuerKeyCompromiseIncident.findUnique.mockResolvedValue(null);

      await expect(
        service.resolveIncident({
          incidentId: "missing",
          actorId: ACTOR_ID,
          organizationId: ORG_ID,
          note: "Done.",
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws ForbiddenException for a caller from another organization", async () => {
      prisma.issuerKeyCompromiseIncident.findUnique.mockResolvedValue(
        makeIncident({ state: IssuerKeyCompromiseIncidentState.CONTAINED }),
      );
      prisma.issuer.findUnique.mockResolvedValue(makeIssuer());

      await expect(
        service.resolveIncident({
          incidentId: "incident-1",
          actorId: ACTOR_ID,
          organizationId: OTHER_ORG_ID,
          note: "Done.",
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("rejects a resolution note of 1025 characters", async () => {
      await expect(
        service.resolveIncident({
          incidentId: "incident-1",
          actorId: ACTOR_ID,
          organizationId: ORG_ID,
          note: "n".repeat(1025),
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("processOpenIncidents — containment", () => {
    function arrangeOpenIncident(keyOverrides: Record<string, unknown> = {}) {
      const incident = makeIncident();
      prisma.issuerKeyCompromiseIncident.findMany.mockResolvedValue([incident]);
      prisma.issuerSigningKey.findUnique.mockResolvedValue(
        makeKey({
          state: IssuerKeyLifecycleState.COMPROMISED,
          compromisedAt: new Date("2026-11-19T12:00:00.000Z"),
          contractSyncedAt: new Date("2026-11-01T00:00:00.000Z"),
          ...keyOverrides,
        }),
      );
      prisma.credentialVerificationKeyTrustPin.findMany.mockResolvedValue([]);
      prisma.credentialVerificationKeyTrustPin.updateMany.mockResolvedValue({
        count: 0,
      });
      prisma.credentialQuarantine.findMany.mockResolvedValue([]);
      prisma.issuerPolicyCommitment.findMany.mockResolvedValue([]);
      prisma.proof.count.mockResolvedValue(0);
      prisma.issuerKeyCompromiseIncident.update.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(makeIncident({ ...data, id: "incident-1" })),
      );
      return incident;
    }

    it("contains an OPEN incident with a deterministic evidence hash", async () => {
      const incident = arrangeOpenIncident();

      const result = await service.processOpenIncidents();

      expect(result).toEqual({ examined: 1, contained: 1, skipped: 0 });
      const update = prisma.issuerKeyCompromiseIncident.update.mock.calls[0][0];
      expect(update.data.state).toBe(
        IssuerKeyCompromiseIncidentState.CONTAINED,
      );
      expect(update.data.evidenceHash).toBe(
        computeEvidenceHash({
          incidentId: incident.id,
          issuerId: ISSUER_ID,
          keyId: KEY_ID,
          compromisedAt: incident.compromisedAt.toISOString(),
          commitmentHash: incident.commitmentHash,
          trustPinsRevoked: 2,
          affectedQuarantines: 0,
          affectedProofs: 0,
        }),
      );
      expect(update.data.contractReconciledAt).toEqual(
        new Date("2026-11-01T00:00:00.000Z"),
      );
      expect(update.data.containedAt).toEqual(expect.any(Date));
    });

    it("revokes straggler pins and adds them to the revoked count", async () => {
      arrangeOpenIncident();
      prisma.credentialVerificationKeyTrustPin.findMany.mockResolvedValue([
        { id: "pin-late" },
      ]);
      prisma.credentialVerificationKeyTrustPin.updateMany.mockResolvedValue({
        count: 1,
      });

      await service.processOpenIncidents();

      const update = prisma.issuerKeyCompromiseIncident.update.mock.calls[0][0];
      expect(update.data.trustPinsRevoked).toBe(3);
    });

    it("leaves the incident OPEN when the key is no longer COMPROMISED", async () => {
      arrangeOpenIncident({ state: IssuerKeyLifecycleState.ACTIVE });

      const result = await service.processOpenIncidents();

      expect(result).toEqual({ examined: 1, contained: 0, skipped: 1 });
      expect(prisma.issuerKeyCompromiseIncident.update).not.toHaveBeenCalled();
    });

    it("leaves the incident OPEN when the key commitment drifted", async () => {
      arrangeOpenIncident({
        commitmentHash: "sha256:drifted-commitment",
      });

      const result = await service.processOpenIncidents();

      expect(result).toEqual({ examined: 1, contained: 0, skipped: 1 });
      expect(prisma.issuerKeyCompromiseIncident.update).not.toHaveBeenCalled();
    });

    it("leaves the incident OPEN with no contract sync on record", async () => {
      arrangeOpenIncident({ contractSyncedAt: null });

      await service.processOpenIncidents();

      const update = prisma.issuerKeyCompromiseIncident.update.mock.calls[0][0];
      expect(update.data.contractReconciledAt).toBeNull();
      expect(update.data.contractReconciliationNote).toContain(
        "No contract sync on record",
      );
    });

    it("processes nothing when there are no OPEN incidents", async () => {
      prisma.issuerKeyCompromiseIncident.findMany.mockResolvedValue([]);

      const result = await service.processOpenIncidents();

      expect(result).toEqual({ examined: 0, contained: 0, skipped: 0 });
    });

    it("clamps the batch to at most 10 incidents per run", async () => {
      prisma.issuerKeyCompromiseIncident.findMany.mockResolvedValue([]);

      await service.processOpenIncidents(50);

      expect(prisma.issuerKeyCompromiseIncident.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: MAX_OPEN_INCIDENTS_PER_RUN }),
      );
    });
  });

  describe("computeEvidenceHash — determinism", () => {
    const evidence = {
      incidentId: "incident-1",
      issuerId: ISSUER_ID,
      keyId: KEY_ID,
      compromisedAt: "2026-11-19T12:00:00.000Z",
      commitmentHash: "sha256:test-commitment-hash",
      trustPinsRevoked: 2,
      affectedQuarantines: 1,
      affectedProofs: 3,
    };

    it("is deterministic for the same evidence", () => {
      expect(computeEvidenceHash(evidence)).toBe(computeEvidenceHash(evidence));
      expect(computeEvidenceHash(evidence)).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("changes when any evidence field changes", () => {
      expect(
        computeEvidenceHash({ ...evidence, trustPinsRevoked: 3 }),
      ).not.toBe(computeEvidenceHash(evidence));
    });
  });
});

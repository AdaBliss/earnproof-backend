import { IssuerAssuranceLevel, ResourceStatus } from "@prisma/client";
import { IssuerReconciliationService } from "./issuer-reconciliation.service";

const NOW = new Date("2026-09-24T12:00:00.000Z");
const SKEW = 60_000;

function expiredIssuer(overrides: Record<string, unknown> = {}) {
  return {
    id: "issuer-1",
    stellarAddress:
      "GBFXVVSIVZHCSLMZ23N7QDOSFKMCXFQZ7S3KBXCGYZTZZBDSJ2SPCZYZ",
    status: ResourceStatus.ACTIVE,
    assuranceLevel: IssuerAssuranceLevel.STANDARD,
    accreditationExpiresAt: new Date(NOW.getTime() - 2 * SKEW),
    accreditationSyncedAt: new Date(NOW.getTime() - 3_600_000),
    updatedAt: new Date(NOW.getTime() - 3_600_000),
    ...overrides,
  };
}

function configMock(enabled = true) {
  return {
    get: (key: string) =>
      ({
        "issuerRegistry.enabled": enabled,
        "issuerRegistry.contractId": enabled ? "CCONTRACT" : "",
        "stellar.network": "testnet",
      })[key],
  };
}

function buildService(prisma: unknown, registry: unknown, enabled = true) {
  return new IssuerReconciliationService(
    prisma as never,
    configMock(enabled) as never,
    registry as never,
  );
}

describe("IssuerReconciliationService accreditation expiry", () => {
  let prisma: {
    issuer: {
      findMany: jest.Mock;
      updateMany: jest.Mock;
      count: jest.Mock;
    };
    reconciliationConflict: { count: jest.Mock };
    issuerReconciliationCheckpoint: {
      findUnique: jest.Mock;
      upsert: jest.Mock;
      update: jest.Mock;
    };
    auditLog: { create: jest.Mock };
  };
  let registry: { readIssuerAssurance: jest.Mock };

  beforeEach(() => {
    prisma = {
      issuer: {
        findMany: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
      },
      reconciliationConflict: { count: jest.fn().mockResolvedValue(0) },
      issuerReconciliationCheckpoint: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    registry = { readIssuerAssurance: jest.fn() };
  });

  function foundAssurance(overrides: Record<string, unknown> = {}) {
    return {
      state: "found",
      issuerAddress:
        "GBFXVVSIVZHCSLMZ23N7QDOSFKMCXFQZ7S3KBXCGYZTZZBDSJ2SPCZYZ",
      assuranceLevel: IssuerAssuranceLevel.STANDARD,
      accreditationExpiresAt: new Date(NOW.getTime() - 2 * SKEW),
      contractId: "CCONTRACT",
      network: "testnet",
      observedAt: NOW,
      ...overrides,
    };
  }

  it("selects only expired, accredited issuers, bounded and oldest-expiry first", async () => {
    const service = buildService(prisma, registry);
    prisma.issuer.findMany.mockResolvedValue([]);

    await service.reconcileAccreditationExpiry(NOW);

    expect(prisma.issuer.findMany).toHaveBeenCalledWith({
      where: {
        status: ResourceStatus.ACTIVE,
        assuranceLevel: { not: IssuerAssuranceLevel.NONE },
        accreditationExpiresAt: {
          not: null,
          lte: new Date(NOW.getTime() - SKEW),
        },
      },
      select: expect.objectContaining({ id: true, accreditationExpiresAt: true }),
      take: 30,
      orderBy: { accreditationExpiresAt: "asc" },
    });
  });

  it("confirms an unchanged projection and only moves the observation marker", async () => {
    const service = buildService(prisma, registry);
    prisma.issuer.findMany.mockResolvedValue([expiredIssuer()]);
    registry.readIssuerAssurance.mockResolvedValue(foundAssurance());

    const summary = await service.reconcileAccreditationExpiry(NOW);

    expect(summary).toEqual({
      checked: 1,
      refreshed: 0,
      unchanged: 1,
      skipped: 0,
    });
    expect(prisma.issuer.updateMany).toHaveBeenCalledWith({
      where: { id: "issuer-1", status: ResourceStatus.ACTIVE },
      data: {
        assuranceLevel: IssuerAssuranceLevel.STANDARD,
        accreditationExpiresAt: new Date(NOW.getTime() - 2 * SKEW),
        accreditationSyncedAt: NOW,
        accreditationContractId: "CCONTRACT",
      },
    });
    // No audit spam for a projection the contract confirmed.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("adopts a renewed accreditation from the contract and audits the change", async () => {
    const service = buildService(prisma, registry);
    prisma.issuer.findMany.mockResolvedValue([expiredIssuer()]);
    const renewedExpiry = new Date(NOW.getTime() + 30 * 24 * 3_600_000);
    registry.readIssuerAssurance.mockResolvedValue(
      foundAssurance({ accreditationExpiresAt: renewedExpiry }),
    );

    const summary = await service.reconcileAccreditationExpiry(NOW);

    expect(summary).toEqual({
      checked: 1,
      refreshed: 1,
      unchanged: 0,
      skipped: 0,
    });
    expect(prisma.issuer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assuranceLevel: IssuerAssuranceLevel.STANDARD,
          accreditationExpiresAt: renewedExpiry,
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "RECONCILE_ACCREDITATION",
        resourceType: "Issuer",
        resourceId: "issuer-1",
        metadata: expect.objectContaining({
          previousAssuranceLevel: IssuerAssuranceLevel.STANDARD,
          newAssuranceLevel: IssuerAssuranceLevel.STANDARD,
          newAccreditationExpiresAt: renewedExpiry.toISOString(),
          contractId: "CCONTRACT",
        }),
      }),
    });
  });

  it("adopts a withdrawn accreditation (level NONE) from the contract", async () => {
    const service = buildService(prisma, registry);
    prisma.issuer.findMany.mockResolvedValue([expiredIssuer()]);
    registry.readIssuerAssurance.mockResolvedValue(
      foundAssurance({
        assuranceLevel: IssuerAssuranceLevel.NONE,
        accreditationExpiresAt: null,
      }),
    );

    const summary = await service.reconcileAccreditationExpiry(NOW);

    expect(summary.refreshed).toBe(1);
    expect(prisma.issuer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assuranceLevel: IssuerAssuranceLevel.NONE,
          accreditationExpiresAt: null,
        }),
      }),
    );
    // The stored lifecycle status is never moved to EXPIRED by this pass.
    expect(prisma.issuer.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: expect.anything() }),
      }),
    );
  });

  it("skips the issuer and leaves it untouched when the contract read fails", async () => {
    const service = buildService(prisma, registry);
    prisma.issuer.findMany.mockResolvedValue([expiredIssuer()]);
    registry.readIssuerAssurance.mockResolvedValue({
      state: "failed",
      error: "contract unreachable",
    });

    const summary = await service.reconcileAccreditationExpiry(NOW);

    expect(summary).toEqual({
      checked: 1,
      refreshed: 0,
      unchanged: 0,
      skipped: 1,
    });
    expect(prisma.issuer.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("skips the issuer when the registry is disabled", async () => {
    const service = buildService(prisma, registry);
    prisma.issuer.findMany.mockResolvedValue([expiredIssuer()]);
    registry.readIssuerAssurance.mockResolvedValue({
      state: "disabled",
      reason: "not configured",
    });

    const summary = await service.reconcileAccreditationExpiry(NOW);

    expect(summary.skipped).toBe(1);
    expect(prisma.issuer.updateMany).not.toHaveBeenCalled();
  });

  it("skips a row that left ACTIVE between the read and the write", async () => {
    const service = buildService(prisma, registry);
    prisma.issuer.findMany.mockResolvedValue([expiredIssuer()]);
    registry.readIssuerAssurance.mockResolvedValue(foundAssurance());
    prisma.issuer.updateMany.mockResolvedValue({ count: 0 });

    const summary = await service.reconcileAccreditationExpiry(NOW);

    expect(summary).toEqual({
      checked: 1,
      refreshed: 0,
      unchanged: 0,
      skipped: 1,
    });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("aggregates outcomes across the batch and keeps going after a failure", async () => {
    const service = buildService(prisma, registry);
    prisma.issuer.findMany.mockResolvedValue([
      expiredIssuer({ id: "issuer-1" }),
      expiredIssuer({ id: "issuer-2" }),
    ]);
    registry.readIssuerAssurance
      .mockResolvedValueOnce(foundAssurance())
      .mockResolvedValueOnce({ state: "failed", error: "boom" });

    const summary = await service.reconcileAccreditationExpiry(NOW);

    expect(summary).toEqual({
      checked: 2,
      refreshed: 0,
      unchanged: 1,
      skipped: 1,
    });
  });

  it("does nothing when the registry is not enabled", async () => {
    const service = buildService(prisma, registry, false);

    const summary = await service.reconcileAccreditationExpiry(NOW);

    expect(summary).toEqual({
      checked: 0,
      refreshed: 0,
      unchanged: 0,
      skipped: 0,
    });
    expect(prisma.issuer.findMany).not.toHaveBeenCalled();
  });

  it("runs the expiry pass as part of the scheduled reconcile cycle", async () => {
    const service = buildService(prisma, registry);
    prisma.issuerReconciliationCheckpoint.upsert.mockResolvedValue({
      id: "issuer_reconciliation",
    });
    // First call is reconcileSyncedIssuers (no synced issuers), second is
    // the accreditation expiry pass (none due).
    prisma.issuer.findMany.mockResolvedValue([]);
    registry.readIssuerAssurance.mockResolvedValue(foundAssurance());

    await service.reconcile();

    expect(prisma.issuer.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.issuer.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          accreditationExpiresAt: expect.objectContaining({
            lte: expect.any(Date),
          }),
        }),
      }),
    );
  });

  it("reports the expired-accreditation count in the reconciliation status", async () => {
    const service = buildService(prisma, registry);
    prisma.issuerReconciliationCheckpoint.findUnique.mockResolvedValue({
      lastSyncedAt: NOW,
      syncState: "SYNCED",
    });
    prisma.issuer.count.mockResolvedValue(3);

    const status = await service.getReconciliationStatus();

    expect(status).toEqual(
      expect.objectContaining({ expiredAccreditationCount: 3 }),
    );
    expect(prisma.issuer.count).toHaveBeenCalledWith({
      where: {
        status: ResourceStatus.ACTIVE,
        assuranceLevel: { not: IssuerAssuranceLevel.NONE },
        accreditationExpiresAt: {
          not: null,
          lte: expect.any(Date),
        },
      },
    });
  });
});

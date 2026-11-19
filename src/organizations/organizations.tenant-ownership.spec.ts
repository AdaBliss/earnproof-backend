/**
 * Tenant-ownership tests for OrganizationsService.getTenantScopedOrganization,
 * the direct-service read path for callers that bypass controller guards
 * (other services, background jobs). Prisma and collaborators are mocked;
 * no database is required.
 */
import { NotFoundException } from "@nestjs/common";
import { MissingTenantContextError } from "../common/database/tenant-context";
import { TenantOwnershipMismatchError } from "../common/database/tenant-context";
import { OrganizationsService } from "./organizations.service";

describe("OrganizationsService.getTenantScopedOrganization", () => {
  let service: OrganizationsService;
  let prisma: any;

  const ORG_ID = "org_test_123";
  const OTHER_ORG_ID = "org_other_456";

  const orgRow = {
    id: ORG_ID,
    name: "Test Org",
    slug: "test-org",
    website: null,
    status: "ACTIVE",
    revision: 0,
    createdById: "user_owner",
    createdAt: new Date("2026-10-22T10:00:00.000Z"),
    updatedAt: new Date("2026-10-22T10:00:00.000Z"),
    archivedAt: null,
    deletedAt: null,
    legalHoldAt: null,
  };

  beforeEach(() => {
    prisma = {
      organization: { findUnique: jest.fn() },
      organizationMember: { findUnique: jest.fn() },
      issuer: { count: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    service = new OrganizationsService(prisma, {} as any, {} as any);
  });

  it("returns the organization for a matching tenant context", async () => {
    prisma.organization.findUnique.mockResolvedValue(orgRow);
    const result = await service.getTenantScopedOrganization(
      { organizationId: ORG_ID, source: "job", actorId: "my-job" },
      ORG_ID,
    );
    expect(result).toEqual(orgRow);
    expect(prisma.organization.findUnique).toHaveBeenCalledWith({
      where: { id: ORG_ID },
    });
  });

  it("fails closed without a tenant context and reads nothing", async () => {
    await expect(
      service.getTenantScopedOrganization(null, ORG_ID),
    ).rejects.toThrow(MissingTenantContextError);
    await expect(
      service.getTenantScopedOrganization(undefined, ORG_ID),
    ).rejects.toThrow(MissingTenantContextError);
    expect(prisma.organization.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a context for a different organization before reading", async () => {
    await expect(
      service.getTenantScopedOrganization(
        { organizationId: OTHER_ORG_ID, source: "request" },
        ORG_ID,
      ),
    ).rejects.toThrow(TenantOwnershipMismatchError);
    expect(prisma.organization.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a foreign-owned row read back (defense in depth)", async () => {
    prisma.organization.findUnique.mockResolvedValue({
      ...orgRow,
      id: OTHER_ORG_ID,
    });
    // The requested id matches the context, but the row read back belongs
    // to another tenant — e.g. a stale or inconsistent read.
    await expect(
      service.getTenantScopedOrganization(
        { organizationId: ORG_ID, source: "request" },
        ORG_ID,
      ),
    ).rejects.toThrow(TenantOwnershipMismatchError);
  });

  it("reports a missing organization as not found", async () => {
    prisma.organization.findUnique.mockResolvedValue(null);
    await expect(
      service.getTenantScopedOrganization(
        { organizationId: ORG_ID, source: "request" },
        ORG_ID,
      ),
    ).rejects.toThrow(NotFoundException);
  });
});

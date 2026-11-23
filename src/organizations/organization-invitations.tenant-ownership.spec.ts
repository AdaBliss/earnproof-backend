/**
 * Tenant-ownership tests for OrganizationInvitationsService.
 *
 * Covers the wired assertion behaviour (not the invitation business
 * rules, which live in organization-invitations.service.spec.ts):
 * list/get paths scope their queries to the requesting tenant, a row
 * owned by another tenant is hidden, and the background-job cleanup
 * entry point fails closed without an explicit tenant context.
 *
 * Prisma is mocked; no database is required.
 */
import { NotFoundException } from "@nestjs/common";
import {
  OrganizationInvitationStatus,
  OrganizationMemberRole,
  ResourceStatus,
} from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";
import { sha256 } from "../common/crypto/hash";
import {
  MissingTenantContextError,
  TenantContext,
} from "../common/database/tenant-context";
import { FixedClock } from "../../test/time/fixed-clock";
import { OrganizationInvitationsService } from "./organization-invitations.service";

describe("OrganizationInvitationsService tenant ownership", () => {
  let service: OrganizationInvitationsService;
  let prisma: any;
  let clock: FixedClock;

  const ORG_ID = "org_test_123";
  const OTHER_ORG_ID = "org_other_456";
  const WALLET = "GBWM4FST7D2Q5YJ6F2R2L3D7Y4Y5W6E7R8T9Y0U1I2O3P4A5S6D7F8G9";

  const adminUser: AuthenticatedUser = {
    id: "user_admin",
    walletAddress: WALLET,
    walletHash: sha256(WALLET),
    role: "WORKER",
  };

  const jobContext: TenantContext = {
    organizationId: ORG_ID,
    source: "job",
    actorId: "invitation-expiry-cleanup",
  };

  beforeEach(() => {
    clock = new FixedClock("2026-10-22T10:00:00.000Z");

    prisma = {
      organization: {
        findUnique: jest.fn().mockResolvedValue({
          id: ORG_ID,
          name: "Test Org",
          archivedAt: null,
          deletedAt: null,
        }),
      },
      organizationMember: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          const { userId, organizationId } =
            where.organizationId_userId ?? {};
          if (organizationId === ORG_ID && userId === "user_admin") {
            return Promise.resolve({
              id: "mem_admin",
              organizationId,
              userId,
              role: OrganizationMemberRole.ADMIN,
              status: ResourceStatus.ACTIVE,
            });
          }
          return Promise.resolve(null);
        }),
      },
      organizationInvitation: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };

    service = new OrganizationInvitationsService(prisma, clock);
  });

  describe("listInvitations", () => {
    it("scopes the query to the requesting tenant", async () => {
      await service.listInvitations(adminUser, ORG_ID, {
        page: 1,
        limit: 10,
      });

      expect(prisma.organizationInvitation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: ORG_ID },
          skip: 0,
          take: 10,
        }),
      );
      expect(prisma.organizationInvitation.count).toHaveBeenCalledWith({
        where: { organizationId: ORG_ID },
      });
    });

    it("keeps the tenant predicate alongside other filters", async () => {
      await service.listInvitations(adminUser, ORG_ID, {
        page: 1,
        limit: 10,
        status: OrganizationInvitationStatus.PENDING,
      });

      expect(prisma.organizationInvitation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId: ORG_ID,
            status: OrganizationInvitationStatus.PENDING,
          },
        }),
      );
    });

    it("fails closed for a malformed organizationId before querying", async () => {
      await expect(
        service.listInvitations(adminUser, "org/123", {
          page: 1,
          limit: 10,
        }),
      ).rejects.toThrow(MissingTenantContextError);
      expect(prisma.organizationInvitation.findMany).not.toHaveBeenCalled();
      expect(prisma.organizationInvitation.count).not.toHaveBeenCalled();
    });
  });

  describe("getInvitation", () => {
    it("returns an invitation owned by the requesting tenant", async () => {
      prisma.organizationInvitation.findUnique.mockResolvedValue({
        id: "inv_1",
        organizationId: ORG_ID,
        role: OrganizationMemberRole.MEMBER,
        inviterId: "user_admin",
        recipientWalletAddress: WALLET,
        recipientWalletHash: sha256(WALLET),
        status: OrganizationInvitationStatus.PENDING,
        expiresAt: new Date("2026-10-29T10:00:00.000Z"),
        acceptedAt: null,
        acceptedById: null,
        declinedAt: null,
        declinedById: null,
        revokedAt: null,
        revokedById: null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      });

      const result = await service.getInvitation(adminUser, ORG_ID, "inv_1");
      expect(result.id).toBe("inv_1");
      expect(result.organizationId).toBe(ORG_ID);
    });

    it("reports a foreign-tenant invitation as not found (regression)", async () => {
      prisma.organizationInvitation.findUnique.mockResolvedValue({
        id: "inv_2",
        organizationId: OTHER_ORG_ID,
        role: OrganizationMemberRole.MEMBER,
        inviterId: "user_admin",
        recipientWalletAddress: WALLET,
        recipientWalletHash: sha256(WALLET),
        status: OrganizationInvitationStatus.PENDING,
        expiresAt: new Date("2026-10-29T10:00:00.000Z"),
        acceptedAt: null,
        acceptedById: null,
        declinedAt: null,
        declinedById: null,
        revokedAt: null,
        revokedById: null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      });

      // The row exists and was read back, but belongs to another tenant:
      // the caller must not learn that.
      await expect(
        service.getInvitation(adminUser, ORG_ID, "inv_2"),
      ).rejects.toThrow(NotFoundException);
    });

    it("reports a missing invitation as not found", async () => {
      prisma.organizationInvitation.findUnique.mockResolvedValue(null);
      await expect(
        service.getInvitation(adminUser, ORG_ID, "inv_missing"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("cleanupExpiredInvitations (background-job path)", () => {
    it("scopes the reconciliation to the job's tenant context", async () => {
      prisma.organizationInvitation.updateMany.mockResolvedValueOnce({
        count: 5,
      });

      const result = await service.cleanupExpiredInvitations(jobContext);

      expect(result.reconciledCount).toBe(5);
      expect(prisma.organizationInvitation.updateMany).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          status: OrganizationInvitationStatus.PENDING,
          expiresAt: { lte: clock.now() },
        },
        data: { status: OrganizationInvitationStatus.EXPIRED },
      });
    });

    it("fails closed without a tenant context and touches nothing", async () => {
      await expect(
        service.cleanupExpiredInvitations(
          undefined as unknown as TenantContext,
        ),
      ).rejects.toThrow(MissingTenantContextError);
      await expect(
        service.cleanupExpiredInvitations(null as unknown as TenantContext),
      ).rejects.toThrow(MissingTenantContextError);
      expect(prisma.organizationInvitation.updateMany).not.toHaveBeenCalled();
    });

    it("fails closed for a job context with a malformed organizationId", async () => {
      await expect(
        service.cleanupExpiredInvitations({
          organizationId: "",
          source: "job",
        }),
      ).rejects.toThrow(MissingTenantContextError);
      expect(prisma.organizationInvitation.updateMany).not.toHaveBeenCalled();
    });
  });
});

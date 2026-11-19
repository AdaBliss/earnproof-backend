/**
 * Focused tests for TenantDataAccess, the injectable wrapper around the
 * tenant-context assertions — including the background-job entry point
 * `runInTenantScope`, which must validate the job's tenant context before
 * the handler (and therefore before any data access) runs.
 */
import { NotFoundException } from "@nestjs/common";
import {
  MissingTenantContextError,
  TenantContext,
  TenantOwnershipMismatchError,
} from "./tenant-context";
import { TenantDataAccess } from "./tenant-data-access.service";

const ORG_ID = "org_test_123";
const OTHER_ORG_ID = "org_other_456";

const requestContext: TenantContext = {
  organizationId: ORG_ID,
  source: "request",
  actorId: "user_owner",
};

describe("TenantDataAccess", () => {
  let service: TenantDataAccess;

  beforeEach(() => {
    service = new TenantDataAccess();
    // Silence the denial logs: the denials are asserted on the error,
    // not on the log output.
    jest.spyOn((service as any).logger, "warn").mockImplementation(() => {});
  });

  describe("requireContext / scopedWhere", () => {
    it("returns a frozen validated context", () => {
      const result = service.requireContext(requestContext);
      expect(result).toEqual(requestContext);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("fails closed on a missing context", () => {
      expect(() => service.requireContext(null)).toThrow(
        MissingTenantContextError,
      );
      expect(() => service.requireContext(undefined)).toThrow(
        MissingTenantContextError,
      );
    });

    it("builds a tenant-scoped where clause", () => {
      expect(
        service.scopedWhere(requestContext, { status: "PENDING" }),
      ).toEqual({ status: "PENDING", organizationId: ORG_ID });
    });

    it("throws on a conflicting organizationId in extra filters", () => {
      expect(() =>
        service.scopedWhere(requestContext, {
          organizationId: OTHER_ORG_ID,
        }),
      ).toThrow(TenantOwnershipMismatchError);
    });
  });

  describe("assertOwned / assertOwnedOrNotFound", () => {
    const ownRow = { id: "inv_1", organizationId: ORG_ID };
    const foreignRow = { id: "inv_2", organizationId: OTHER_ORG_ID };

    it("returns an owned row and throws on a foreign row", () => {
      expect(service.assertOwned(ownRow, requestContext)).toBe(ownRow);
      expect(() =>
        service.assertOwned(foreignRow, requestContext),
      ).toThrow(TenantOwnershipMismatchError);
    });

    it("maps a foreign row to 404 on the read path", () => {
      expect(() =>
        service.assertOwnedOrNotFound(foreignRow, requestContext, {
          resourceType: "OrganizationInvitation",
        }),
      ).toThrow(NotFoundException);
    });

    it("fails closed on a missing context for both variants", () => {
      expect(() => service.assertOwned(ownRow, null)).toThrow(
        MissingTenantContextError,
      );
      expect(() => service.assertOwnedOrNotFound(ownRow, null)).toThrow(
        MissingTenantContextError,
      );
    });
  });

  describe("runInTenantScope (background-job path)", () => {
    it("runs the handler with the validated, frozen context", async () => {
      const handler = jest.fn(async (tenant: TenantContext) => {
        expect(Object.isFrozen(tenant)).toBe(true);
        return `cleaned:${tenant.organizationId}`;
      });
      await expect(
        service.runInTenantScope(
          { organizationId: ORG_ID, source: "job", actorId: "my-job" },
          { operation: "cleanupExpiredInvitations" },
          handler,
        ),
      ).resolves.toBe(`cleaned:${ORG_ID}`);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("fails closed before the handler runs when the context is missing", async () => {
      const handler = jest.fn(async () => "must-not-run");
      await expect(
        service.runInTenantScope(null, { operation: "sweep" }, handler),
      ).rejects.toThrow(MissingTenantContextError);
      // No data access happened: the handler never ran.
      expect(handler).not.toHaveBeenCalled();
    });

    it("fails closed before the handler runs when the context is malformed", async () => {
      const handler = jest.fn(async () => "must-not-run");
      await expect(
        service.runInTenantScope(
          { organizationId: "", source: "job" },
          { operation: "sweep" },
          handler,
        ),
      ).rejects.toThrow(MissingTenantContextError);
      expect(handler).not.toHaveBeenCalled();
    });

    it("propagates handler errors unchanged", async () => {
      const boom = new Error("downstream failure");
      await expect(
        service.runInTenantScope(
          requestContext,
          { operation: "sweep" },
          async () => {
            throw boom;
          },
        ),
      ).rejects.toBe(boom);
    });
  });
});

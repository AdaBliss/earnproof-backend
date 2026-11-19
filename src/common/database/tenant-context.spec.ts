/**
 * Focused tests for the repository/service-layer tenant ownership
 * assertions: positive, negative, boundary, and authorization cases.
 *
 * These are pure-function tests — no database, no Nest container — so
 * they run in the unit suite.
 */
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import {
  assertTenantIdMatches,
  assertTenantOwnership,
  assertTenantOwnershipOrNotFound,
  isTenantOwned,
  isValidTenantId,
  MAX_TENANT_ID_LENGTH,
  MissingTenantContextError,
  requireTenantContext,
  TenantContext,
  TenantOwnershipMismatchError,
  tenantContextFromJob,
  tenantContextFromRequest,
  tenantWhere,
} from "./tenant-context";

const ORG_ID = "org_test_123";
const OTHER_ORG_ID = "org_other_456";

const requestContext: TenantContext = {
  organizationId: ORG_ID,
  source: "request",
  actorId: "user_owner",
};

const jobContext: TenantContext = {
  organizationId: ORG_ID,
  source: "job",
  actorId: "invitation-expiry-cleanup",
};

const user = {
  id: "user_owner",
  walletAddress: "GBWM4FST7D2Q5YJ6F2R2L3D7Y4Y5W6E7R8T9Y0U1I2O3P4A5S6D7F8G9",
  walletHash: "hash",
  role: "WORKER",
};

describe("tenant-context", () => {
  describe("requireTenantContext", () => {
    it("accepts a valid request context and returns a frozen copy", () => {
      const result = requireTenantContext(requestContext);
      expect(result).toEqual(requestContext);
      expect(Object.isFrozen(result)).toBe(true);
      // Mutating the original after validation must not widen the copy.
      (requestContext as { organizationId: string }).organizationId =
        OTHER_ORG_ID;
      expect(result.organizationId).toBe(ORG_ID);
      (requestContext as { organizationId: string }).organizationId = ORG_ID;
    });

    it("accepts a valid job context", () => {
      expect(requireTenantContext(jobContext)).toEqual(jobContext);
    });

    it.each([null, undefined])(
      "fails closed when the context is %s",
      (missing) => {
        expect(() => requireTenantContext(missing)).toThrow(
          MissingTenantContextError,
        );
        expect(() => requireTenantContext(missing)).toThrow(
          ForbiddenException,
        );
      },
    );

    it.each(["", "   ", 123, {}, []])(
      "fails closed for a malformed organizationId (%p)",
      (badId) => {
        expect(() =>
          requireTenantContext({
            organizationId: badId as unknown as string,
            source: "request",
          }),
        ).toThrow(MissingTenantContextError);
      },
    );

    it("fails closed for an unknown source", () => {
      expect(() =>
        requireTenantContext({
          organizationId: ORG_ID,
          source: "system" as unknown as TenantContext["source"],
        }),
      ).toThrow(MissingTenantContextError);
    });

    it("exposes a stable 403 error body without the offending value", () => {
      try {
        requireTenantContext(null, { operation: "listInvitations" });
        fail("should have thrown");
      } catch (error) {
        const err = error as MissingTenantContextError;
        expect(err.getStatus()).toBe(403);
        expect(err.getResponse()).toEqual({
          code: "TENANT_CONTEXT_MISSING",
          message: "Tenant context is required for listInvitations",
        });
      }
    });
  });

  describe("isValidTenantId (boundary)", () => {
    it("accepts a 1-character id and a max-length id", () => {
      expect(isValidTenantId("a")).toBe(true);
      expect(isValidTenantId("x".repeat(MAX_TENANT_ID_LENGTH))).toBe(true);
    });

    it("rejects an id one character over the bound", () => {
      expect(isValidTenantId("x".repeat(MAX_TENANT_ID_LENGTH + 1))).toBe(
        false,
      );
    });

    it("rejects ids with path, space, or quote characters", () => {
      for (const bad of [
        "org/123",
        "org 123",
        "org'123",
        'org"123',
        "org;DROP",
        "org\n123",
      ]) {
        expect(isValidTenantId(bad)).toBe(false);
      }
    });

    it("accepts cuid-style ids with dashes and underscores", () => {
      expect(isValidTenantId("cm123abc-DEF_456")).toBe(true);
    });
  });

  describe("tenantContextFromRequest / tenantContextFromJob", () => {
    it("derives a request context from the user and the route org id", () => {
      expect(tenantContextFromRequest(user, ORG_ID)).toEqual({
        organizationId: ORG_ID,
        source: "request",
        actorId: "user_owner",
      });
    });

    it("falls back to the user's own organizationId when the route has none", () => {
      expect(
        tenantContextFromRequest({ ...user, organizationId: ORG_ID }),
      ).toEqual({
        organizationId: ORG_ID,
        source: "request",
        actorId: "user_owner",
      });
    });

    it("fails closed when neither the route nor the user carries an org id", () => {
      expect(() => tenantContextFromRequest(user)).toThrow(
        MissingTenantContextError,
      );
    });

    it("derives a job context from an explicit payload organizationId", () => {
      expect(
        tenantContextFromJob({
          organizationId: ORG_ID,
          jobName: "invitation-expiry-cleanup",
        }),
      ).toEqual({
        organizationId: ORG_ID,
        source: "job",
        actorId: "invitation-expiry-cleanup",
      });
    });

    it("fails closed for a job payload without an organizationId", () => {
      expect(() => tenantContextFromJob({})).toThrow(
        MissingTenantContextError,
      );
      expect(() =>
        tenantContextFromJob({ organizationId: null }),
      ).toThrow(MissingTenantContextError);
    });
  });

  describe("tenantWhere", () => {
    it("adds the tenant predicate to extra filters", () => {
      expect(
        tenantWhere(requestContext, { status: "PENDING" }),
      ).toEqual({ status: "PENDING", organizationId: ORG_ID });
    });

    it("works with no extra filters", () => {
      expect(tenantWhere(requestContext)).toEqual({
        organizationId: ORG_ID,
      });
    });

    it("fails closed when the context is missing", () => {
      expect(() => tenantWhere(null, { status: "PENDING" })).toThrow(
        MissingTenantContextError,
      );
    });

    it("throws on an extra organizationId that disagrees with the context", () => {
      expect(() =>
        tenantWhere(requestContext, { organizationId: OTHER_ORG_ID }),
      ).toThrow(TenantOwnershipMismatchError);
    });

    it("accepts an extra organizationId that agrees with the context", () => {
      expect(
        tenantWhere(requestContext, { organizationId: ORG_ID }),
      ).toEqual({ organizationId: ORG_ID });
    });

    it("does not mutate the caller's extra object", () => {
      const extra = { status: "PENDING" };
      tenantWhere(requestContext, extra);
      expect(extra).toEqual({ status: "PENDING" });
    });
  });

  describe("assertTenantOwnership / isTenantOwned", () => {
    const ownRow = { id: "inv_1", organizationId: ORG_ID };
    const foreignRow = { id: "inv_2", organizationId: OTHER_ORG_ID };

    it("returns a row owned by the tenant", () => {
      expect(assertTenantOwnership(ownRow, requestContext)).toBe(ownRow);
    });

    it("returns null rows as-is (caller maps to 404)", () => {
      expect(assertTenantOwnership(null, requestContext)).toBeNull();
      expect(assertTenantOwnership(undefined, requestContext)).toBeUndefined();
    });

    it("throws on a row owned by another tenant", () => {
      expect(() =>
        assertTenantOwnership(foreignRow, requestContext, {
          resourceType: "OrganizationInvitation",
        }),
      ).toThrow(TenantOwnershipMismatchError);
    });

    it("fails closed when the context is missing, even for an owned row", () => {
      expect(() => assertTenantOwnership(ownRow, null)).toThrow(
        MissingTenantContextError,
      );
    });

    it("treats a row with a null organizationId as not owned", () => {
      expect(
        isTenantOwned({ organizationId: null }, ORG_ID),
      ).toBe(false);
      expect(() =>
        assertTenantOwnership({ organizationId: null }, requestContext),
      ).toThrow(TenantOwnershipMismatchError);
    });

    it("exposes a stable 403 body that never names either tenant", () => {
      try {
        assertTenantOwnership(foreignRow, requestContext, {
          resourceType: "OrganizationInvitation",
        });
        fail("should have thrown");
      } catch (error) {
        const err = error as TenantOwnershipMismatchError;
        expect(err.getStatus()).toBe(403);
        expect(err.getResponse()).toEqual({
          code: "TENANT_OWNERSHIP_MISMATCH",
          message:
            "Resource does not belong to the requesting tenant (OrganizationInvitation)",
        });
      }
    });
  });

  describe("assertTenantOwnershipOrNotFound", () => {
    const ownRow = { id: "inv_1", organizationId: ORG_ID };
    const foreignRow = { id: "inv_2", organizationId: OTHER_ORG_ID };

    it("returns a row owned by the tenant", () => {
      expect(
        assertTenantOwnershipOrNotFound(ownRow, requestContext),
      ).toBe(ownRow);
    });

    it("maps a foreign row to 404 (information hiding)", () => {
      expect(() =>
        assertTenantOwnershipOrNotFound(foreignRow, requestContext, {
          resourceType: "OrganizationInvitation",
        }),
      ).toThrow(NotFoundException);
      try {
        assertTenantOwnershipOrNotFound(foreignRow, requestContext, {
          resourceType: "OrganizationInvitation",
        });
        fail("should have thrown");
      } catch (error) {
        expect((error as NotFoundException).message).toBe(
          "OrganizationInvitation not found",
        );
      }
    });

    it("maps a missing row to 404", () => {
      expect(() =>
        assertTenantOwnershipOrNotFound(null, requestContext, {
          resourceType: "OrganizationInvitation",
        }),
      ).toThrow(NotFoundException);
    });

    it("still fails closed on a missing context", () => {
      expect(() =>
        assertTenantOwnershipOrNotFound(ownRow, null),
      ).toThrow(MissingTenantContextError);
    });
  });

  describe("assertTenantIdMatches", () => {
    it("passes when the id matches the context", () => {
      expect(() =>
        assertTenantIdMatches(ORG_ID, requestContext),
      ).not.toThrow();
    });

    it("throws on a different id", () => {
      expect(() =>
        assertTenantIdMatches(OTHER_ORG_ID, requestContext, {
          resourceType: "Organization",
        }),
      ).toThrow(TenantOwnershipMismatchError);
    });

    it("throws on a missing or malformed id", () => {
      expect(() => assertTenantIdMatches(null, requestContext)).toThrow(
        TenantOwnershipMismatchError,
      );
      expect(() => assertTenantIdMatches("", requestContext)).toThrow(
        TenantOwnershipMismatchError,
      );
    });

    it("fails closed on a missing context", () => {
      expect(() => assertTenantIdMatches(ORG_ID, null)).toThrow(
        MissingTenantContextError,
      );
    });
  });
});

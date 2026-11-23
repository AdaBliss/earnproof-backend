import { IssuerAssuranceLevel, ResourceStatus } from "@prisma/client";
import {
  accreditationStatusWhereInput,
  canAssertActiveAccreditation,
  computeEffectiveAccreditationStatus,
  DEFAULT_ACCREDITATION_CLOCK_SKEW_MS,
  DEFAULT_ACCREDITATION_MAX_AGE_MS,
  isAccreditationStale,
} from "./issuer-assurance";

const NOW = new Date("2026-09-24T12:00:00.000Z");
const SKEW = DEFAULT_ACCREDITATION_CLOCK_SKEW_MS; // 1 minute
const MAX_AGE = DEFAULT_ACCREDITATION_MAX_AGE_MS; // 1 hour

function issuer(overrides: {
  status?: ResourceStatus;
  assuranceLevel?: IssuerAssuranceLevel | null;
  accreditationExpiresAt?: Date | null;
  accreditationSyncedAt?: Date | null;
  revokedAt?: Date | null;
}) {
  return {
    status: ResourceStatus.ACTIVE,
    assuranceLevel: IssuerAssuranceLevel.STANDARD,
    accreditationExpiresAt: null,
    accreditationSyncedAt: NOW,
    revokedAt: null,
    ...overrides,
  };
}

describe("computeEffectiveAccreditationStatus", () => {
  it("is ACTIVE for an accredited issuer with a future expiry", () => {
    expect(
      computeEffectiveAccreditationStatus(
        issuer({
          accreditationExpiresAt: new Date(NOW.getTime() + 3_600_000),
        }),
        NOW,
        SKEW,
      ),
    ).toBe("ACTIVE");
  });

  it("is ACTIVE for a perpetual accreditation with no expiry", () => {
    expect(
      computeEffectiveAccreditationStatus(
        issuer({ accreditationExpiresAt: null }),
        NOW,
        SKEW,
      ),
    ).toBe("ACTIVE");
  });

  it("is NOT_ACCREDITED when the assurance level is NONE", () => {
    expect(
      computeEffectiveAccreditationStatus(
        issuer({
          assuranceLevel: IssuerAssuranceLevel.NONE,
          accreditationExpiresAt: new Date(NOW.getTime() + 3_600_000),
        }),
        NOW,
        SKEW,
      ),
    ).toBe("NOT_ACCREDITED");
  });

  it("treats a missing assurance level as NONE, never as accredited", () => {
    expect(
      computeEffectiveAccreditationStatus(
        issuer({ assuranceLevel: null }),
        NOW,
        SKEW,
      ),
    ).toBe("NOT_ACCREDITED");
    expect(
      computeEffectiveAccreditationStatus(
        issuer({ assuranceLevel: undefined }),
        NOW,
        SKEW,
      ),
    ).toBe("NOT_ACCREDITED");
  });

  it("is EXPIRED once past expiry beyond the skew tolerance", () => {
    expect(
      computeEffectiveAccreditationStatus(
        issuer({
          accreditationExpiresAt: new Date(NOW.getTime() - SKEW - 1),
        }),
        NOW,
        SKEW,
      ),
    ).toBe("EXPIRED");
  });

  it("treats the skew boundary deterministically (still ACTIVE at exactly expiry+skew)", () => {
    const expiresAt = new Date(NOW.getTime() - SKEW);
    expect(
      computeEffectiveAccreditationStatus(issuer({ accreditationExpiresAt: expiresAt }), NOW, SKEW),
    ).toBe("ACTIVE");
    // One millisecond past the boundary flips to EXPIRED.
    expect(
      computeEffectiveAccreditationStatus(
        issuer({
          accreditationExpiresAt: new Date(expiresAt.getTime() - 1),
        }),
        NOW,
        SKEW,
      ),
    ).toBe("EXPIRED");
  });

  it("revocation wins over expiry and over accreditation", () => {
    expect(
      computeEffectiveAccreditationStatus(
        issuer({
          revokedAt: NOW,
          accreditationExpiresAt: new Date(NOW.getTime() - 10 * SKEW),
        }),
        NOW,
        SKEW,
      ),
    ).toBe("REVOKED");
    expect(
      computeEffectiveAccreditationStatus(
        issuer({ status: ResourceStatus.REVOKED }),
        NOW,
        SKEW,
      ),
    ).toBe("REVOKED");
  });

  it("reports suspended, pending, and deleted as-is", () => {
    expect(
      computeEffectiveAccreditationStatus(
        issuer({ status: ResourceStatus.SUSPENDED }),
        NOW,
        SKEW,
      ),
    ).toBe("SUSPENDED");
    expect(
      computeEffectiveAccreditationStatus(
        issuer({ status: ResourceStatus.PENDING }),
        NOW,
        SKEW,
      ),
    ).toBe("PENDING");
    expect(
      computeEffectiveAccreditationStatus(
        issuer({ status: ResourceStatus.DELETED }),
        NOW,
        SKEW,
      ),
    ).toBe("DELETED");
  });

  it("never expires an accreditation whose level is NONE", () => {
    expect(
      computeEffectiveAccreditationStatus(
        issuer({
          assuranceLevel: IssuerAssuranceLevel.NONE,
          accreditationExpiresAt: new Date(NOW.getTime() - 10 * SKEW),
        }),
        NOW,
        SKEW,
      ),
    ).toBe("NOT_ACCREDITED");
  });
});

describe("isAccreditationStale", () => {
  it("is stale when the accreditation was never observed from the contract", () => {
    expect(
      isAccreditationStale(
        issuer({ accreditationSyncedAt: null }),
        NOW,
        SKEW,
        MAX_AGE,
      ),
    ).toBe(true);
  });

  it("is fresh at exactly the max-age bound and stale one millisecond past it", () => {
    const syncedAt = new Date(NOW.getTime() - MAX_AGE);
    expect(
      isAccreditationStale(issuer({ accreditationSyncedAt: syncedAt }), NOW, SKEW, MAX_AGE),
    ).toBe(false);
    expect(
      isAccreditationStale(
        issuer({
          accreditationSyncedAt: new Date(syncedAt.getTime() - 1),
        }),
        NOW,
        SKEW,
        MAX_AGE,
      ),
    ).toBe(true);
  });

  it("is not stale for issuers that are not asserting accreditation", () => {
    // Expired and never-accredited projections already fail closed; there is
    // nothing stale left to guard.
    expect(
      isAccreditationStale(
        issuer({
          accreditationExpiresAt: new Date(NOW.getTime() - 2 * SKEW),
          accreditationSyncedAt: null,
        }),
        NOW,
        SKEW,
        MAX_AGE,
      ),
    ).toBe(false);
    expect(
      isAccreditationStale(
        issuer({
          assuranceLevel: IssuerAssuranceLevel.NONE,
          accreditationSyncedAt: null,
        }),
        NOW,
        SKEW,
        MAX_AGE,
      ),
    ).toBe(false);
  });
});

describe("canAssertActiveAccreditation", () => {
  it("permits only a fresh, effectively ACTIVE accreditation", () => {
    expect(
      canAssertActiveAccreditation(
        issuer({
          accreditationExpiresAt: new Date(NOW.getTime() + SKEW),
        }),
        NOW,
        SKEW,
        MAX_AGE,
      ),
    ).toBe(true);
  });

  it("refuses an expired accreditation even when freshly observed", () => {
    expect(
      canAssertActiveAccreditation(
        issuer({
          accreditationExpiresAt: new Date(NOW.getTime() - 2 * SKEW),
          accreditationSyncedAt: NOW,
        }),
        NOW,
        SKEW,
        MAX_AGE,
      ),
    ).toBe(false);
  });

  it("refuses an unexpired accreditation whose observation is stale", () => {
    expect(
      canAssertActiveAccreditation(
        issuer({
          accreditationExpiresAt: new Date(NOW.getTime() + 3_600_000),
          accreditationSyncedAt: new Date(NOW.getTime() - MAX_AGE - 1),
        }),
        NOW,
        SKEW,
        MAX_AGE,
      ),
    ).toBe(false);
  });

  it("refuses an unexpired accreditation that was never observed", () => {
    expect(
      canAssertActiveAccreditation(
        issuer({
          accreditationExpiresAt: new Date(NOW.getTime() + 3_600_000),
          accreditationSyncedAt: null,
        }),
        NOW,
        SKEW,
        MAX_AGE,
      ),
    ).toBe(false);
  });

  it("refuses revoked, suspended, pending, and never-accredited issuers", () => {
    for (const status of [
      ResourceStatus.REVOKED,
      ResourceStatus.SUSPENDED,
      ResourceStatus.PENDING,
    ]) {
      expect(
        canAssertActiveAccreditation(issuer({ status }), NOW, SKEW, MAX_AGE),
      ).toBe(false);
    }
    expect(
      canAssertActiveAccreditation(
        issuer({ assuranceLevel: IssuerAssuranceLevel.NONE }),
        NOW,
        SKEW,
        MAX_AGE,
      ),
    ).toBe(false);
  });
});

describe("accreditationStatusWhereInput", () => {
  it("maps ACTIVE to a level + unexpired-or-perpetual fragment", () => {
    expect(accreditationStatusWhereInput("ACTIVE", NOW, SKEW)).toEqual({
      status: ResourceStatus.ACTIVE,
      assuranceLevel: { not: IssuerAssuranceLevel.NONE },
      OR: [
        { accreditationExpiresAt: null },
        { accreditationExpiresAt: { gte: new Date(NOW.getTime() - SKEW) } },
      ],
    });
  });

  it("maps EXPIRED to a level + past-expiry fragment on the same boundary", () => {
    expect(accreditationStatusWhereInput("EXPIRED", NOW, SKEW)).toEqual({
      status: ResourceStatus.ACTIVE,
      assuranceLevel: { not: IssuerAssuranceLevel.NONE },
      accreditationExpiresAt: { lt: new Date(NOW.getTime() - SKEW) },
    });
  });

  it("maps NOT_ACCREDITED to level NONE", () => {
    expect(accreditationStatusWhereInput("NOT_ACCREDITED", NOW, SKEW)).toEqual({
      status: ResourceStatus.ACTIVE,
      assuranceLevel: IssuerAssuranceLevel.NONE,
    });
  });

  it.each([
    ["REVOKED", ResourceStatus.REVOKED],
    ["SUSPENDED", ResourceStatus.SUSPENDED],
    ["PENDING", ResourceStatus.PENDING],
    ["DELETED", ResourceStatus.DELETED],
  ] as const)("maps %s to its stored status", (effective, stored) => {
    expect(accreditationStatusWhereInput(effective, NOW, SKEW)).toEqual({
      status: stored,
    });
  });

  it("ACTIVE and EXPIRED fragments partition the boundary with no overlap", () => {
    // At exactly expiry+skew the pure function says ACTIVE; the ACTIVE
    // fragment's gte cutoff includes that instant while EXPIRED's lt
    // excludes it, so a row can never match both filters.
    const active = accreditationStatusWhereInput("ACTIVE", NOW, SKEW);
    const expired = accreditationStatusWhereInput("EXPIRED", NOW, SKEW);
    const activeCutoff = (active.OR as { accreditationExpiresAt?: { gte?: Date } }[])[1]
      .accreditationExpiresAt?.gte;
    const expiredCutoff = (
      expired as { accreditationExpiresAt?: { lt?: Date } }
    ).accreditationExpiresAt?.lt;
    expect(activeCutoff?.getTime()).toBe(expiredCutoff?.getTime());
  });
});

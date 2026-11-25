import { IssuerAssuranceLevel, Prisma, ResourceStatus } from "@prisma/client";

/**
 * The effective accreditation status of an issuer.
 *
 * Stored `status` records lifecycle decisions (active, suspended, revoked);
 * it does not by itself account for accreditation, which is a contract-backed
 * fact with its own level and expiry. The effective status folds the
 * contract-observed assurance level and expiry into the stored status so
 * every reader — the API, the reconciliation job, a consumer filter — reaches
 * the same verdict from the same inputs, without mutating the stored row.
 *
 * `NOT_ACCREDITED` is explicit and distinct from "unknown": an issuer whose
 * assurance level is NONE has no contract-backed accreditation and must never
 * be read as accredited, however its stored status looks.
 */
export type EffectiveAccreditationStatus =
  | "ACTIVE"
  | "EXPIRED"
  | "NOT_ACCREDITED"
  | "REVOKED"
  | "SUSPENDED"
  | "PENDING"
  | "DELETED";

/** The minimal issuer fields the effective accreditation status depends on. */
export interface IssuerAccreditationInput {
  status: ResourceStatus;
  /** Absent on rows written before this feature; treated as NONE. */
  assuranceLevel?: IssuerAssuranceLevel | null;
  accreditationExpiresAt?: Date | null;
  accreditationSyncedAt?: Date | null;
  revokedAt?: Date | null;
}

/**
 * Default clock-skew tolerance, in milliseconds.
 *
 * An accreditation is treated as expired only once the clock is past its
 * expiry by more than this tolerance, so a small difference between the
 * contract's clock and this service's clock does not flip a just-valid
 * accreditation to expired. Chosen conservatively at one minute, matching the
 * attestation skew; overridable per call for tests and configuration.
 */
export const DEFAULT_ACCREDITATION_CLOCK_SKEW_MS = 60_000;

/**
 * Default staleness bound for a contract observation, in milliseconds.
 *
 * A projection whose accreditation was last observed from the contract more
 * than this long ago cannot assert active accreditation: the contract may
 * have revoked or expired it since, and the reconciler (which runs every 5
 * minutes) should have re-observed it by now. One hour leaves ample margin
 * over the reconciliation interval while still failing closed promptly.
 * Overridable per call for tests and configuration.
 */
export const DEFAULT_ACCREDITATION_MAX_AGE_MS = 60 * 60_000;

/**
 * Compute the effective accreditation status of an issuer at instant `now`.
 *
 * Precedence is explicit and total, so the outcome is deterministic:
 *  1. Revoked (by flag or status) wins over everything — revocation is final.
 *  2. Suspended, pending, and deleted are reported as-is.
 *  3. An active issuer with assurance level NONE is NOT_ACCREDITED: no
 *     contract-backed accreditation has ever been observed.
 *  4. An accredited issuer past its expiry (plus skew) is EXPIRED.
 *  5. Otherwise ACTIVE. An accreditation with no expiry is perpetual.
 *
 * The expiry comparison is strict and one-sided: expired only when
 * `now > accreditationExpiresAt + clockSkewMs`. At exactly the boundary the
 * accreditation is still valid, so the boundary belongs to exactly one side
 * every time — the same rule the database filter in
 * {@link accreditationStatusWhereInput} uses, so the API and the query agree.
 */
export function computeEffectiveAccreditationStatus(
  issuer: IssuerAccreditationInput,
  now: Date,
  clockSkewMs: number = DEFAULT_ACCREDITATION_CLOCK_SKEW_MS,
): EffectiveAccreditationStatus {
  if (issuer.revokedAt != null || issuer.status === ResourceStatus.REVOKED) {
    return "REVOKED";
  }
  if (issuer.status === ResourceStatus.SUSPENDED) return "SUSPENDED";
  if (issuer.status === ResourceStatus.PENDING) return "PENDING";
  if (issuer.status === ResourceStatus.DELETED) return "DELETED";

  if (
    issuer.assuranceLevel == null ||
    issuer.assuranceLevel === IssuerAssuranceLevel.NONE
  ) {
    return "NOT_ACCREDITED";
  }

  if (
    issuer.accreditationExpiresAt != null &&
    now.getTime() >
      issuer.accreditationExpiresAt.getTime() + clockSkewMs
  ) {
    return "EXPIRED";
  }

  return "ACTIVE";
}

/**
 * Whether the accreditation projection is stale at instant `now`.
 *
 * Stale means "looks accredited, but the contract observation behind that
 * claim is too old or missing to trust". It only applies to an issuer whose
 * effective status is ACTIVE: an expired, revoked, or never-accredited
 * issuer is already not asserting accreditation, so there is nothing stale
 * to fail closed on. A projection is stale when it was never observed
 * (`accreditationSyncedAt` is null) or when the observation is older than
 * `maxAgeMs`; at exactly the bound it is still fresh.
 */
export function isAccreditationStale(
  issuer: IssuerAccreditationInput,
  now: Date,
  clockSkewMs: number = DEFAULT_ACCREDITATION_CLOCK_SKEW_MS,
  maxAgeMs: number = DEFAULT_ACCREDITATION_MAX_AGE_MS,
): boolean {
  if (
    computeEffectiveAccreditationStatus(issuer, now, clockSkewMs) !== "ACTIVE"
  ) {
    return false;
  }
  if (issuer.accreditationSyncedAt == null) return true;
  return now.getTime() - issuer.accreditationSyncedAt.getTime() > maxAgeMs;
}

/**
 * Whether an issuer's accreditation may be asserted as active at `now`.
 *
 * Only an effectively ACTIVE accreditation with a fresh contract observation
 * qualifies. Expired, revoked, suspended, pending, deleted, and
 * never-accredited issuers never qualify — and neither does an ACTIVE-looking
 * projection whose contract observation is stale or missing. This is the
 * single predicate list and detail endpoints use to answer "is this issuer
 * currently accredited", so a stale projection can never assert it.
 */
export function canAssertActiveAccreditation(
  issuer: IssuerAccreditationInput,
  now: Date,
  clockSkewMs: number = DEFAULT_ACCREDITATION_CLOCK_SKEW_MS,
  maxAgeMs: number = DEFAULT_ACCREDITATION_MAX_AGE_MS,
): boolean {
  return (
    computeEffectiveAccreditationStatus(issuer, now, clockSkewMs) ===
      "ACTIVE" && !isAccreditationStale(issuer, now, clockSkewMs, maxAgeMs)
  );
}

/**
 * Translate an effective-accreditation filter value into a Prisma `where`
 * fragment, using the same strict, one-sided expiry boundary as
 * {@link computeEffectiveAccreditationStatus}.
 *
 * The fragment carries its own `status` for the lifecycle-implied values
 * (REVOKED, SUSPENDED, PENDING, DELETED); callers combine it with their other
 * filters under `AND`, so a caller-supplied `status` that disagrees with the
 * implied one yields an empty result instead of silently winning.
 */
export function accreditationStatusWhereInput(
  status: EffectiveAccreditationStatus,
  now: Date,
  clockSkewMs: number = DEFAULT_ACCREDITATION_CLOCK_SKEW_MS,
): Prisma.IssuerWhereInput {
  const cutoff = new Date(now.getTime() - clockSkewMs);
  switch (status) {
    case "ACTIVE":
      return {
        status: ResourceStatus.ACTIVE,
        assuranceLevel: { not: IssuerAssuranceLevel.NONE },
        OR: [
          { accreditationExpiresAt: null },
          { accreditationExpiresAt: { gte: cutoff } },
        ],
      };
    case "EXPIRED":
      return {
        status: ResourceStatus.ACTIVE,
        assuranceLevel: { not: IssuerAssuranceLevel.NONE },
        accreditationExpiresAt: { lt: cutoff },
      };
    case "NOT_ACCREDITED":
      return {
        status: ResourceStatus.ACTIVE,
        assuranceLevel: IssuerAssuranceLevel.NONE,
      };
    case "REVOKED":
      return { status: ResourceStatus.REVOKED };
    case "SUSPENDED":
      return { status: ResourceStatus.SUSPENDED };
    case "PENDING":
      return { status: ResourceStatus.PENDING };
    case "DELETED":
      return { status: ResourceStatus.DELETED };
  }
}

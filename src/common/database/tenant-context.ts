/**
 * Repository / service-layer tenant ownership assertions.
 *
 * Controller guards and membership checks alone cannot protect against a
 * direct service call — or a background job — that queries tenant-scoped
 * data without a tenant predicate. These helpers are the application-layer
 * complement to database-level row-level security (RLS): RLS is the last
 * line of defence in Postgres, while these assertions fail closed *before*
 * any query is issued, so a missing or mismatched tenant context is a loud
 * programming error instead of a silent cross-tenant read or write.
 *
 * Rules enforced here (all deterministic, bounded, and side-effect free):
 *
 * 1. Fail closed — a missing, empty, or malformed tenant context throws
 *    {@link MissingTenantContextError} before any data access happens.
 * 2. The tenant predicate always wins — `tenantWhere` overwrites any
 *    `organizationId` a caller smuggles in through extra predicates, and
 *    throws {@link TenantOwnershipMismatchError} if that value disagrees
 *    with the context instead of silently picking one.
 * 3. Ownership is asserted on rows read back — `assertTenantOwnership`
 *    throws on a mismatch; `assertTenantOwnershipOrNotFound` maps a
 *    mismatch to 404 (information hiding, matching the existing
 *    `getVisibleOrganization` convention) for read paths.
 * 4. Tenant ids are bounded — at most {@link MAX_TENANT_ID_LENGTH}
 *    characters, `[A-Za-z0-9_-]` only, so a context value can never carry
 *    unbounded or injection-shaped input into a query.
 *
 * Nothing in this module touches the database or the clock, so it is safe
 * to call from request handlers, direct service calls, and background jobs
 * alike. The injectable {@link TenantDataAccess} wrapper adds logging for
 * the same checks.
 */
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { AuthenticatedUser } from "../../auth/auth.types";

/** Maximum length of a tenant (organization) id accepted in a context. */
export const MAX_TENANT_ID_LENGTH = 128;

/**
 * Characters allowed in a tenant id. Organization ids are opaque
 * database ids (cuid-style); anything outside this set is malformed and
 * fails closed rather than being passed to a query.
 */
export const TENANT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Where a tenant context came from. Jobs have no request user. */
export type TenantContextSource = "request" | "job";

/**
 * The tenant scope every tenant-scoped data access must carry.
 * `actorId` is the requesting user for request-scoped access, or the job
 * name for job-scoped access; it is audit metadata only and never used
 * as an authorization substitute.
 */
export interface TenantContext {
  organizationId: string;
  source: TenantContextSource;
  actorId?: string;
}

/** A row (or partial row) carrying the tenant it belongs to. */
export interface TenantOwned {
  organizationId: string | null | undefined;
}

/** Options shared by the assertion helpers. */
export interface TenantAssertionOptions {
  /** Operation being performed, e.g. "listInvitations". Logged on denial. */
  operation?: string;
  /** Resource type being accessed, e.g. "OrganizationInvitation". */
  resourceType?: string;
}

/**
 * Raised when tenant-scoped data access is attempted without a valid
 * tenant context. Maps to 403 with a stable `{ code, message }` body so
 * the global exception filter renders it like other authorization
 * failures. The message never includes the offending value.
 */
export class MissingTenantContextError extends ForbiddenException {
  readonly code = "TENANT_CONTEXT_MISSING";

  constructor(operation?: string) {
    // ForbiddenException hard-codes status 403; the object body is passed
    // through verbatim, giving the stable { code, message } shape.
    super({
      code: "TENANT_CONTEXT_MISSING",
      message: operation
        ? `Tenant context is required for ${operation}`
        : "Tenant context is required",
    });
  }
}

/**
 * Raised when a tenant context and the tenant of the data being accessed
 * disagree. Maps to 403 with a stable `{ code, message }` body. The
 * message never includes either tenant id, so a cross-tenant probe learns
 * nothing about the other tenant.
 */
export class TenantOwnershipMismatchError extends ForbiddenException {
  readonly code = "TENANT_OWNERSHIP_MISMATCH";

  constructor(resourceType?: string) {
    super({
      code: "TENANT_OWNERSHIP_MISMATCH",
      message: resourceType
        ? `Resource does not belong to the requesting tenant (${resourceType})`
        : "Resource does not belong to the requesting tenant",
    });
  }
}

/**
 * Validates a tenant id: a non-empty string within the length bound and
 * matching {@link TENANT_ID_PATTERN}. Returns the id unchanged when
 * valid, `null` otherwise — callers decide whether that fails closed
 * (service paths) or is a plain validation failure.
 */
export function isValidTenantId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_TENANT_ID_LENGTH &&
    TENANT_ID_PATTERN.test(value)
  );
}

/**
 * Requires a tenant context and returns a frozen copy of it, so a caller
 * cannot mutate the context after validation and widen its own scope.
 * Throws {@link MissingTenantContextError} for a missing context or a
 * malformed `organizationId` — fail closed, before any data access.
 */
export function requireTenantContext(
  context: TenantContext | null | undefined,
  options?: TenantAssertionOptions,
): TenantContext {
  if (!context || !isValidTenantId(context.organizationId)) {
    throw new MissingTenantContextError(options?.operation);
  }
  if (context.source !== "request" && context.source !== "job") {
    throw new MissingTenantContextError(options?.operation);
  }
  return Object.freeze({
    organizationId: context.organizationId,
    source: context.source,
    ...(context.actorId !== undefined ? { actorId: context.actorId } : {}),
  });
}

/**
 * Builds a request-scoped tenant context from the authenticated user and
 * the organization id taken from the route (or the user's own
 * `organizationId` when the route carries none). The context is validated
 * by {@link requireTenantContext}, so a malformed id fails closed here.
 */
export function tenantContextFromRequest(
  user: AuthenticatedUser,
  organizationId?: string | null,
): TenantContext {
  return requireTenantContext({
    organizationId: organizationId ?? user.organizationId ?? "",
    source: "request",
    actorId: user.id,
  });
}

/**
 * Builds a job-scoped tenant context from a background-job payload. A
 * job has no request user, so the payload itself must carry an explicit
 * `organizationId`; a job without one fails closed instead of sweeping
 * across tenants.
 */
export function tenantContextFromJob(
  payload: { organizationId?: string | null; jobName?: string },
  options?: TenantAssertionOptions,
): TenantContext {
  return requireTenantContext(
    {
      organizationId: payload.organizationId ?? "",
      source: "job",
      ...(payload.jobName !== undefined
        ? { actorId: payload.jobName }
        : {}),
    },
    options,
  );
}

/**
 * Merges a validated tenant context into a Prisma `where` input. The
 * tenant predicate always wins: an `organizationId` smuggled in through
 * `extra` that disagrees with the context throws
 * {@link TenantOwnershipMismatchError} instead of being silently
 * overwritten, and one that agrees is simply normalised away.
 */
export function tenantWhere<T extends Record<string, unknown>>(
  context: TenantContext | null | undefined,
  extra?: T,
  options?: TenantAssertionOptions,
): T & { organizationId: string } {
  const tenant = requireTenantContext(context, options);
  const extraOrg = (extra as { organizationId?: unknown } | undefined)
    ?.organizationId;
  if (extraOrg !== undefined && extraOrg !== tenant.organizationId) {
    throw new TenantOwnershipMismatchError(options?.resourceType);
  }
  const rest: Record<string, unknown> = { ...(extra ?? {}) };
  // The tenant predicate always wins: drop any caller-supplied
  // organizationId (one that agrees was normalised away above).
  delete rest.organizationId;
  return { ...rest, organizationId: tenant.organizationId } as T & {
    organizationId: string;
  };
}

/** Pure predicate: does this row belong to this tenant? */
export function isTenantOwned(
  record: TenantOwned | null | undefined,
  organizationId: string,
): boolean {
  return record?.organizationId === organizationId;
}

/**
 * Asserts that a row read back from the database belongs to the tenant in
 * `context`. A `null` row is returned as-is (the caller maps it to 404);
 * a row owned by another tenant throws
 * {@link TenantOwnershipMismatchError}. Use for writes and for reads
 * where the caller must distinguish "not yours" from "not found".
 */
export function assertTenantOwnership<T extends TenantOwned>(
  record: T | null | undefined,
  context: TenantContext | null | undefined,
  options?: TenantAssertionOptions,
): T | null | undefined {
  const tenant = requireTenantContext(context, options);
  if (record === null || record === undefined) {
    return record;
  }
  if (!isTenantOwned(record, tenant.organizationId)) {
    throw new TenantOwnershipMismatchError(options?.resourceType);
  }
  return record;
}

/**
 * Read-path variant of {@link assertTenantOwnership}: a row owned by
 * another tenant is reported as not found (information hiding, matching
 * the existing `getVisibleOrganization` convention) instead of 403, so a
 * cross-tenant probe cannot learn that the resource exists.
 */
export function assertTenantOwnershipOrNotFound<T extends TenantOwned>(
  record: T | null | undefined,
  context: TenantContext | null | undefined,
  options?: TenantAssertionOptions,
): T {
  const tenant = requireTenantContext(context, options);
  if (record === null || record === undefined) {
    throw new NotFoundException(
      options?.resourceType
        ? `${options.resourceType} not found`
        : "Resource not found",
    );
  }
  if (!isTenantOwned(record, tenant.organizationId)) {
    throw new NotFoundException(
      options?.resourceType
        ? `${options.resourceType} not found`
        : "Resource not found",
    );
  }
  return record;
}

/**
 * Asserts that a bare tenant id (e.g. a path parameter or a job payload
 * field) matches the tenant context. Use when the id itself — not a row —
 * is the thing being scoped.
 */
export function assertTenantIdMatches(
  organizationId: string | null | undefined,
  context: TenantContext | null | undefined,
  options?: TenantAssertionOptions,
): void {
  const tenant = requireTenantContext(context, options);
  if (!isValidTenantId(organizationId) || organizationId !== tenant.organizationId) {
    throw new TenantOwnershipMismatchError(options?.resourceType);
  }
}

# Tenant ownership assertions (repository / service layer)

Controller guards and membership checks are the first line of defence, but
they cannot protect against a direct service call — or a background job —
that queries tenant-scoped data without a tenant predicate. This document
describes the application-layer assertions that close that gap.

## Where the code lives

- `src/common/database/tenant-context.ts` — pure, side-effect-free
  helpers and error types. No database, no clock, no Nest container, so
  they are safe to call from request handlers, direct service calls, and
  background jobs alike.
- `src/common/database/tenant-data-access.service.ts` — injectable
  `TenantDataAccess` wrapper (registered in the global `CommonModule`)
  that adds structured denial logging around the same checks, plus the
  `runInTenantScope` entry point for background jobs.
- Wired into `src/organizations/organization-invitations.service.ts`
  (`listInvitations`, `getInvitation`, `cleanupExpiredInvitations`) and
  `src/organizations/organizations.service.ts`
  (`getOrganization` issuer count, `getTenantScopedOrganization`).

## Contract

1. **Fail closed.** Every tenant-scoped data access requires a
   `TenantContext` (`{ organizationId, source: "request" | "job",
   actorId? }`). A missing, empty, or malformed context throws
   `MissingTenantContextError` (403, stable code
   `TENANT_CONTEXT_MISSING`) *before* any query is issued. There is no
   unscoped fallback: `cleanupExpiredInvitations` used to sweep all
   organizations when called without an id; it now requires an explicit
   tenant context.
2. **The tenant predicate always wins.** Build `where` clauses with
   `tenantWhere(context, extra)`. An `organizationId` smuggled in through
   `extra` that disagrees with the context throws
   `TenantOwnershipMismatchError` (403, `TENANT_OWNERSHIP_MISMATCH`)
   instead of being silently overwritten.
3. **Ownership is asserted on rows read back.** `assertTenantOwnership`
   throws on a foreign row (use for writes); the read-path variant
   `assertTenantOwnershipOrNotFound` maps a foreign row to 404
   (information hiding, matching the existing `getVisibleOrganization`
   convention). A `null` row is passed through / mapped to 404 by the
   caller. Error messages never include either tenant id.
4. **Tenant ids are bounded.** At most 128 characters, `[A-Za-z0-9_-]`
   only (`isValidTenantId`). Contexts are returned frozen, so a caller
   cannot widen its own scope after validation.
5. **Observable.** `TenantDataAccess` logs every denial at warn level
   (`tenant.context.missing` / `tenant.ownership.mismatch`) with the
   operation and resource type — never a tenant id or row content.

## Background jobs

A job has no request user, so its payload must carry an explicit
`organizationId`. Build the context with `tenantContextFromJob(payload)`
and run the handler through
`TenantDataAccess.runInTenantScope(context, { operation }, handler)`:
the context is validated before the handler runs, so a job without a
tenant reconciles nothing instead of sweeping every tenant. A
cross-tenant sweep, if one is ever genuinely needed, must be a separate
explicitly-authorized system job — not a missing-context fallback.

## Relationship to row-level security (RLS)

These assertions and Postgres RLS are complementary layers, not
duplicates:

- These assertions fail fast in the application, before a query is
  issued, with a typed error and a log line. They catch programming
  errors (a forgotten predicate, a mismatched id) at the call site.
- RLS policies in Postgres are the last line of defence: they bound
  what the database will return even if application code is bypassed
  or a future query forgets the assertion.

Either layer alone is insufficient; both must agree. If RLS is not yet
enabled for a table, these assertions are the only tenant boundary for
it — treat adding RLS coverage as follow-up work, not as a reason to
skip the assertion.

## Existing authorization and privacy guarantees

These helpers add checks; they do not replace or weaken any existing
one. Membership/role checks (`ensureCanManageOrganization`,
`getVisibleOrganization`) still run first where they exist, and the
read-path 404 mapping preserves the existing information-hiding
behaviour. No public API, DTO, or migration changes in this work: the
only intentional behaviour change is the fail-closed
`cleanupExpiredInvitations` (see point 1 above).

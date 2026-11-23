# Row-level security (defense in depth)

High-risk tenant tables get database-enforced isolation in addition to
application authorization. This is a second layer, not a replacement:
every request handler still authorizes through `src/common/guards`
exactly as before. RLS exists so that a bug in application authorization
— a missing check, a wrong `organizationId` filter — cannot turn into a
cross-tenant data leak on the tables that matter most.

## What is protected

Migration `20261217050000_add_row_level_security_tenant_isolation`
enables and **forces** row-level security on eight organization-scoped
tables, each with one policy named `tenant_isolation`:

| Table | Why it is in scope |
|---|---|
| `ApiKey` | Credential material (key hashes) |
| `OrganizationMember` | Who belongs to an organization, and with what role |
| `OrganizationInvitation` | Pending invitations, including recipient wallet addresses |
| `Issuer` | Issuer identities owned by an organization |
| `SupportedAsset` | Per-organization asset eligibility policy |
| `Webhook` | Delivery endpoints and encrypted signing secrets |
| `SecretRetrievalReceipt` | Evidence that a one-time secret was revealed |
| `CredentialVerificationKeyTrustPin` | Per-organization trust decisions for keys |

`FORCE ROW LEVEL SECURITY` matters: without it the policies would not
apply to the table owner, which is the role the application connects as,
and the migration would be security theatre.

Selection criteria: a non-nullable `organizationId` column, plus
credential, membership, or tenant-configuration data. The constants in
`src/database/rls-policy.ts` list the tables; `src/database/rls-migration.spec.ts`
asserts the migration and the constants agree.

## Policy semantics

One predicate, used as both `USING` and `WITH CHECK` so reads, writes,
updates, and deletes are constrained identically. A row is visible and
writable when any of these holds:

1. **The session's tenant matches the row.** The tenant is bound by
   `TenantContextService.withTenantContext` (below).
2. **No tenant is bound.** `current_setting('app.current_organization_id', true)`
   is `NULL` or empty. This is the compatibility clause: migrations,
   seeds, backfills, and background jobs that run without a tenant keep
   working exactly as before, still governed by application
   authorization. RLS engages when a tenant is bound.
3. **The privileged bypass flag is set.** `current_setting('app.rls_bypass', true)`
   is `'1'`. Only `TenantContextService.withBypassContext` sets it, and
   every use is recorded in `RlsBypassAudit`.

## Binding a tenant

```ts
import { TenantContextService } from "./tenant-context.service";

await tenantContext.withTenantContext(organizationId, async (tx) => {
  // Every statement through `tx` sees only this tenant's rows on the
  // eight protected tables. Unprotected tables are unaffected.
  return tx.apiKey.findMany({ where: { status: "ACTIVE" } });
});
```

Rules:

- **Transaction-local only.** The service binds the tenant with
  `SELECT set_config('app.current_organization_id', $1, true)` — the
  `true` makes the setting local to the transaction, exactly like
  `SET LOCAL`. A pooled connection cannot leak one tenant's context
  into the next request that checks the connection out, because the
  setting dies with the transaction that set it. A session-level `SET`
  would survive the checkout and is never used. `set_config` is used
  instead of `SET LOCAL ... = $1` because `SET` does not accept bind
  parameters, and interpolating the value would be injection-prone.
  This is also what makes the design safe under PgBouncer transaction
  pooling: the setting never outlives the transaction either way.
- **Always inside `$transaction`.** `set_config(..., true)` outside a
  transaction is a no-op (PostgreSQL warns and discards it), so the
  service opens its own interactive transaction and runs the caller's
  work inside it, on the single pooled connection that transaction
  holds.
- **Validated and bounded.** The organization id must match
  `^[A-Za-z0-9_-]{1,128}$` (cuid/uuid characters). Anything else is
  rejected with `TenantContextError` before any SQL runs. Values are
  always bound as parameters; validation is a second line of defence,
  not the first.
- **Deterministic.** No randomness, no clock reads, no hidden state.
  The same tenant and the same work produce the same statements.

Request handlers are the intended callers: resolve the organization
through the existing authentication/authorization path, then wrap the
handler's database work in `withTenantContext`. Background jobs that
have no tenant keep running unbound, as today.

## Privileged bypass (maintenance only)

```ts
await tenantContext.withBypassContext(
  { reason: "backfill org slugs after rename", actor: "backfill-job", organizationId: orgId },
  async (tx) => {
    // Cross-tenant reads/writes are permitted here.
  },
);
```

Narrow by construction:

- The caller must supply a non-empty, bounded `reason` (1–256 chars,
  no control characters) and an `actor` (1–128 chars). Both are
  validated before any SQL runs.
- One append-only `RlsBypassAudit` row is written inside the same
  transaction as the bypassed work, so the audit record commits or
  rolls back with the work it authorizes. A bypass with no audit row
  cannot commit. There is deliberately no update or delete path for
  audit rows.
- The flag is transaction-local, so it cannot leak onto a pooled
  connection.
- Do not call this from request handlers, and do not set
  `app.rls_bypass` anywhere else. Request paths bind a tenant instead.

`RlsBypassAudit` itself carries no RLS policy: it is the record of
bypasses, so gating it behind the mechanism it audits would hide the
trail from exactly the maintenance paths that need to read it.

## What is deliberately not covered

- **`AuditLog`.** Its `organizationId` is nullable (the `SYSTEM`
  chain) and it is the tamper-evidence ledger; gating it could break
  chain appends.
- **`Organization`.** The tenant root has no `organizationId` column
  to scope a policy by.
- **`Payment` and `Proof`.** User-scoped (`userId`), not
  organization-scoped. Tenant RLS for them needs a user-context
  policy and is a separate piece of work.
- **Child tables without a direct `organizationId`** (for example
  `WebhookSecretVersion`, `ApiKeyRotation`). They inherit protection
  only through their parent rows in application code; direct-database
  access to a child row without its parent context is still governed
  by application authorization.
- **Default-deny for unbound sessions.** The compatibility clause
  (no tenant bound → every row visible) is intentional for this
  change so that migrations, seeds, and jobs keep working. Flipping
  it to default-deny is a follow-up once every tenant-scoped request
  path binds a context; it is a one-predicate change in the migration
  plus a new migration, but it must wait until the audit of unbound
  reads is complete, because it would otherwise break background work
  that legitimately runs without a tenant.

## Operations

- **Applying the migration.** Additive only: one new table, `ENABLE`/
  `FORCE` plus one policy per table. No columns are dropped, altered,
  or made `NOT NULL`, and no existing rows are rewritten. Normal
  `prisma migrate deploy` as a pre-deploy job (see
  `docs/database-migrations.md`).
- **Rollback.** Drop the `tenant_isolation` policy on each table, then
  disable row-level security on each table, then drop the audit table.
  Disabling RLS restores exactly the pre-migration behavior because
  application authorization is unchanged.
- **Observability.** Bypass use is observable two ways: the
  `RlsBypassAudit` rows (queryable unbound), and the service's `warn`
  logs on bypass start and completion, which carry actor, organization,
  and reason. Tenant binding logs at `debug` with the organization id.
- **Verifying in production.** `SELECT relname, relrowsecurity,
  relforcerowsecurity FROM pg_class WHERE relname = ANY(...)` shows the
  tables are enforced; `SELECT * FROM pg_policies WHERE polname =
  'tenant_isolation'` shows the policies. The integration spec
  `test/integration/row-level-security.int-spec.ts` asserts both, plus
  positive, negative, boundary, pooling, and bypass behavior.

## Tests

- `src/database/tenant-context.service.spec.ts` — validation (positive,
  negative, boundary), transaction-local binding, parameter binding,
  bypass audit ordering, error propagation. No database.
- `src/database/rls-migration.spec.ts` — the migration file's static
  shape: table list matches the constants, `USING` matches `WITH
  CHECK`, no session-level `SET`, no destructive SQL, unique timestamp,
  no new migration-safety issue. No database.
- `test/integration/row-level-security.int-spec.ts` — the policies
  against a real PostgreSQL: catalog assertions, per-tenant isolation
  on all eight tables, silent cross-tenant filtering, write refusal,
  unbound compatibility, no-leak and concurrent-tenant pooling
  checks, and the audited bypass. Requires `TEST_DATABASE_URL`.

-- Row-level security defense in depth for high-risk tenant tables.
--
-- What this adds, and what it deliberately does not change:
--
-- 1. A `RlsBypassAudit` table. Every privileged RLS bypass (see
--    `TenantContextService.withBypassContext`) writes one append-only row
--    here, inside the same transaction as the bypassed work, so the record
--    commits or rolls back with the work it authorizes. The table itself
--    carries no RLS policy: it is the record of bypasses, so gating it
--    behind the mechanism it audits would hide the trail from exactly the
--    maintenance paths that need to read it.
--
-- 2. Row-level-security policies on the eight organization-scoped tables
--    that hold credential material, membership, or tenant configuration:
--    ApiKey, OrganizationMember, OrganizationInvitation, Issuer,
--    SupportedAsset, Webhook, SecretRetrievalReceipt, and
--    CredentialVerificationKeyTrustPin. Each table gets `FORCE ROW LEVEL
--    SECURITY` so the policies apply even to the table owner (the role the
--    application connects as); without FORCE the policies would be inert
--    for the owner and this migration would be security theatre.
--
-- Policy semantics (identical USING and WITH CHECK, so reads, writes,
-- updates, and deletes are all constrained the same way):
--
--   - A row is visible/writable when the session's tenant context matches
--     its `organizationId`. The context is bound with `set_config(...,
--     true)` — transaction-local, never session-level — so a pooled
--     connection cannot leak one tenant's context into another tenant's
--     request. See `TenantContextService` and docs/row-level-security.md.
--   - A row is visible/writable when no tenant context is bound at all
--     (`current_setting(..., true)` is NULL or ''). This is the
--     compatibility clause: migrations, seeds, backfills, and background
--     jobs that run without a tenant keep working exactly as before, still
--     governed by application-level authorization. RLS here is a second
--     layer that engages when a tenant is bound; it is not a replacement
--     for application authorization. Flipping the unset-context clause to
--     default-deny is a deliberate follow-up once every tenant-scoped
--     request path binds a context (see docs/row-level-security.md).
--   - A row is visible/writable when the privileged bypass flag is set
--     (`app.rls_bypass = '1'`). The flag is transaction-local, set only by
--     `TenantContextService.withBypassContext`, and every use is recorded
--     in `RlsBypassAudit` with a bounded reason and actor.
--
-- Tables NOT covered, and why:
--
--   - `AuditLog` has nullable `organizationId` (the SYSTEM chain) and is
--     the tamper-evidence ledger; gating it could break chain appends.
--   - `Organization` itself is the tenant root and has no `organizationId`
--     column to scope a policy by.
--   - `Payment` and `Proof` are user-scoped (`userId`), not
--     organization-scoped; tenant RLS for them needs a user-context
--     policy and is a separate follow-up.
--   - Child tables without a direct `organizationId` (for example
--     `WebhookSecretVersion`, `ApiKeyRotation`) inherit protection only
--     through their parent rows in application code; direct-database
--     access to a child row without its parent context is still governed
--     by application authorization.
--
-- Migration safety:
--
-- - Additive only: one new table, `ENABLE`/`FORCE` plus one policy per
--   listed table. No columns are dropped, altered, or made NOT NULL, and
--   no existing rows are rewritten, so a populated table applies this
--   migration with no data migration and no downtime window beyond the
--   short `ALTER TABLE` locks.
-- - Idempotent in development: each policy is dropped if it exists before
--   it is created, so the migration can be re-run against a scratch
--   database. `prisma migrate deploy` still applies it exactly once.
-- - Rollback: drop the `tenant_isolation` policy on each table, then
--   disable row-level security on each table, then drop the audit table.
--   Disabling RLS restores exactly the pre-migration behavior because
--   application authorization is unchanged.
--
-- Live-database validation: this migration was validated with
-- `prisma validate` / `prisma generate` and the repository's static
-- migration checks in the sandbox. Applying it to a live database was
-- NOT validated here (no PostgreSQL in the sandbox); CI applies the full
-- history to a clean database and `test/integration/schema-migrations`
-- asserts the result matches `schema.prisma`.

-- CreateTable: append-only audit record for privileged RLS bypass use.
CREATE TABLE "RlsBypassAudit" (
    "id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RlsBypassAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RlsBypassAudit_createdAt_idx" ON "RlsBypassAudit"("createdAt");
CREATE INDEX "RlsBypassAudit_actor_createdAt_idx" ON "RlsBypassAudit"("actor", "createdAt");
CREATE INDEX "RlsBypassAudit_organizationId_createdAt_idx" ON "RlsBypassAudit"("organizationId", "createdAt");

ALTER TABLE "RlsBypassAudit" ADD CONSTRAINT "RlsBypassAudit_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row-level security: tenant isolation policies.
--
-- Predicate, repeated per table (PostgreSQL has no policy templating):
--   * no tenant bound  -> legacy behavior, application authorization governs
--   * tenant bound     -> only that tenant's rows
--   * bypass flag set  -> privileged maintenance, audited in RlsBypassAudit

-- ApiKey: credential material (key hashes) for an organization.
ALTER TABLE "ApiKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApiKey" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ApiKey";
CREATE POLICY "tenant_isolation" ON "ApiKey"
  USING (
    current_setting('app.current_organization_id', true) IS NULL
    OR current_setting('app.current_organization_id', true) = ''
    OR "organizationId" = current_setting('app.current_organization_id', true)
    OR current_setting('app.rls_bypass', true) = '1'
  )
  WITH CHECK (
    current_setting('app.current_organization_id', true) IS NULL
    OR current_setting('app.current_organization_id', true) = ''
    OR "organizationId" = current_setting('app.current_organization_id', true)
    OR current_setting('app.rls_bypass', true) = '1'
  );

-- OrganizationMember: who belongs to an organization, and with what role.
ALTER TABLE "OrganizationMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrganizationMember" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "OrganizationMember";
CREATE POLICY "tenant_isolation" ON "OrganizationMember"
  USING (
    current_setting('app.current_organization_id', true) IS NULL
    OR current_setting('app.current_organization_id', true) = ''
    OR "organizationId" = current_setting('app.current_organization_id', true)
    OR current_setting('app.rls_bypass', true) = '1'
  )
  WITH CHECK (
    current_setting('app.current_organization_id', true) IS NULL
    OR current_setting('app.current_organization_id', true) = ''
    OR "organizationId" = current_setting('app.current_organization_id', true)
    OR current_setting('app.rls_bypass', true) = '1'
  );

-- OrganizationInvitation: pending invitations, including recipient wallet addresses.
ALTER TABLE "OrganizationInvitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrganizationInvitation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "OrganizationInvitation";
CREATE POLICY "tenant_isolation" ON "OrganizationInvitation"
  USING (
    current_setting('app.current_organization_id', true) IS NULL
    OR current_setting('app.current_organization_id', true) = ''
    OR "organizationId" = current_setting('app.current_organization_id', true)
    OR current_setting('app.rls_bypass', true) = '1'
  )
  WITH CHECK (
    current_setting('app.current_organization_id', true) IS NULL
    OR current_setting('app.current_organization_id', true) = ''
    OR "organizationId" = current_setting('app.current_organization_id', true)
    OR current_setting('app.rls_bypass', true) = '1'
  );

-- Issuer: issuer identities owned by an organization.
ALTER TABLE "Issuer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Issuer" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "Issuer";
CREATE POLICY "tenant_isolation" ON "Issuer"
  USING (
    current_setting('app.current_organization_id', true) IS NULL
    OR current_setting('app.current_organization_id', true) = ''
    OR "organizationId" = current_setting('app.current_organization_id', true)
    OR current_setting('app.rls_bypass', true) = '1'
  )
  WITH CHECK (
    current_setting('app.current_organization_id', true) IS NULL
    OR current_setting('app.current_organization_id', true) = ''
    OR "organizationId" = current_setting('app.current_organization_id', true)
    OR current_setting('app.rls_bypass', true) = '1'
  );

-- SupportedAsset: per-organization asset eligibility policy.
ALTER TABLE "SupportedAsset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupportedAsset" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "SupportedAsset";
CREATE POLICY "tenant_isolation" ON "SupportedAsset"
  USING (
    current_setting('app.current_organization_id', true) IS NULL
    OR current_setting('app.current_organization_id', true) = ''
    OR "organizationId" = current_setting('app.current_organization_id', true)
    OR current_setting('app.rls_bypass', true) = '1'
  )
  WITH CHECK (
    current_setting('app.current_organization_id', true) IS NULL
    OR current_setting('app.current_organization_id', true) = ''
    OR "organizationId" = current_setting('app.current_organization_id', true)
    OR current_setting('app.rls_bypass', true) = '1'
  );

-- Webhook: per-organization delivery endpoints and encrypted signing secrets.
ALTER TABLE "Webhook" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Webhook" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "Webhook";
CREATE POLICY "tenant_isolation" ON "Webhook"
  USING (
    current_setting('app.current_organization_id', true) IS NULL
    OR current_setting('app.current_organization_id', true) = ''
    OR "organizationId" = current_setting('app.current_organization_id', true)
    OR current_setting('app.rls_bypass', true) = '1'
  )
  WITH CHECK (
    current_setting('app.current_organization_id', true) IS NULL
    OR current_setting('app.current_organization_id', true) = ''
    OR "organizationId" = current_setting('app.current_organization_id', true)
    OR current_setting('app.rls_bypass', true) = '1'
  );

-- SecretRetrievalReceipt: evidence that a one-time secret was revealed.
ALTER TABLE "SecretRetrievalReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SecretRetrievalReceipt" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "SecretRetrievalReceipt";
CREATE POLICY "tenant_isolation" ON "SecretRetrievalReceipt"
  USING (
    current_setting('app.current_organization_id', true) IS NULL
    OR current_setting('app.current_organization_id', true) = ''
    OR "organizationId" = current_setting('app.current_organization_id', true)
    OR current_setting('app.rls_bypass', true) = '1'
  )
  WITH CHECK (
    current_setting('app.current_organization_id', true) IS NULL
    OR current_setting('app.current_organization_id', true) = ''
    OR "organizationId" = current_setting('app.current_organization_id', true)
    OR current_setting('app.rls_bypass', true) = '1'
  );

-- CredentialVerificationKeyTrustPin: per-organization trust decisions for keys.
ALTER TABLE "CredentialVerificationKeyTrustPin" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CredentialVerificationKeyTrustPin" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "CredentialVerificationKeyTrustPin";
CREATE POLICY "tenant_isolation" ON "CredentialVerificationKeyTrustPin"
  USING (
    current_setting('app.current_organization_id', true) IS NULL
    OR current_setting('app.current_organization_id', true) = ''
    OR "organizationId" = current_setting('app.current_organization_id', true)
    OR current_setting('app.rls_bypass', true) = '1'
  )
  WITH CHECK (
    current_setting('app.current_organization_id', true) IS NULL
    OR current_setting('app.current_organization_id', true) = ''
    OR "organizationId" = current_setting('app.current_organization_id', true)
    OR current_setting('app.rls_bypass', true) = '1'
  );

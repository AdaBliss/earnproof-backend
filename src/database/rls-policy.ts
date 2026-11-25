/**
 * Row-level-security policy constants.
 *
 * Single source of truth for the tenant-isolation mechanism introduced by
 * migration `20261217050000_add_row_level_security_tenant_isolation`. The
 * migration SQL is the enforced form; `src/database/rls-migration.spec.ts`
 * asserts the SQL and these constants agree, so a table added here without
 * a policy (or a policy added without a constant) fails the unit suite
 * instead of shipping silently unenforced.
 */

/** PostgreSQL session setting that carries the bound tenant. */
export const RLS_TENANT_SETTING = "app.current_organization_id";

/** PostgreSQL session setting that marks a privileged maintenance bypass. */
export const RLS_BYPASS_SETTING = "app.rls_bypass";

/** PostgreSQL session setting carrying the bypass justification. */
export const RLS_BYPASS_REASON_SETTING = "app.rls_bypass_reason";

/** Value of {@link RLS_BYPASS_SETTING} while a bypass is active. */
export const RLS_BYPASS_ACTIVE_VALUE = "1";

/** Name of the tenant-isolation policy on every protected table. */
export const RLS_TENANT_POLICY_NAME = "tenant_isolation";

/**
 * Organization-scoped tables protected by the `tenant_isolation` policy.
 *
 * Selection criteria: the table has a non-nullable `organizationId` column
 * and holds credential material, membership, or tenant configuration. See
 * docs/row-level-security.md for the tables deliberately left out and why.
 */
export const RLS_TENANT_TABLES = [
  "ApiKey",
  "OrganizationMember",
  "OrganizationInvitation",
  "Issuer",
  "SupportedAsset",
  "Webhook",
  "SecretRetrievalReceipt",
  "CredentialVerificationKeyTrustPin",
] as const;

export type RlsTenantTable = (typeof RLS_TENANT_TABLES)[number];

/** Longest organization id the tenant context accepts (cuid/uuid are far shorter). */
export const MAX_ORGANIZATION_ID_LENGTH = 128;

/** Longest bypass justification the audit record accepts. */
export const MAX_BYPASS_REASON_LENGTH = 256;

/** Longest bypass actor identifier the audit record accepts. */
export const MAX_BYPASS_ACTOR_LENGTH = 128;

/**
 * Characters an organization id may contain.
 *
 * Organization ids are `cuid()` values (and, for imported rows, uuids), so
 * this intentionally rejects quotes, whitespace, semicolons, and anything
 * else that could smuggle a second statement into a setting value, even
 * though values are always bound as parameters rather than interpolated.
 */
export const ORGANIZATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

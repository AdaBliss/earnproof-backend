import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.service";
import {
  MAX_BYPASS_ACTOR_LENGTH,
  MAX_BYPASS_REASON_LENGTH,
  ORGANIZATION_ID_PATTERN,
  RLS_BYPASS_ACTIVE_VALUE,
  RLS_BYPASS_REASON_SETTING,
  RLS_BYPASS_SETTING,
  RLS_TENANT_SETTING,
} from "./rls-policy";

/**
 * Rejected tenant-context or bypass input, before any SQL runs.
 *
 * A plain `Error` subclass (not an HTTP exception): this service is also
 * usable from scripts and jobs, and the caller maps the failure to its own
 * transport. The message never echoes the rejected value back in full —
 * a rejected value is untrusted input, and echoing it into a log or an
 * error response would leak whatever an attacker typed.
 */
export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantContextError";
  }
}

export interface RlsBypassOptions {
  /** Bounded justification for the bypass; recorded in `RlsBypassAudit`. */
  reason: string;
  /** Who invoked the bypass: a user id, service name, or job name. */
  actor: string;
  /** Tenant the maintenance concerns, when it is scoped to one. */
  organizationId?: string;
}

/**
 * True when `value` contains a C0 control character or DEL.
 *
 * Written as a code-point loop rather than a `/[\u0000-\u001f\u007f]/`
 * regex because the linter forbids control characters in regular
 * expressions (`no-control-regex`).
 */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code !== undefined && (code < 0x20 || code === 0x7f)) {
      return true;
    }
  }
  return false;
}

/**
 * Session-bound tenant context for PostgreSQL row-level security.
 *
 * The database policies created by migration
 * `20261217050000_add_row_level_security_tenant_isolation` read two
 * settings — `app.current_organization_id` and `app.rls_bypass` — to
 * decide which rows a statement may see. This service is the only
 * sanctioned way to set them, and it sets them in exactly one way:
 *
 * - **Transaction-local only.** Values are bound with
 *   `set_config(name, value, true)` — the `true` makes the setting local
 *   to the current transaction, exactly like `SET LOCAL`. A pooled
 *   connection cannot leak one tenant's context into the next request
 *   that checks the connection out, because the setting dies with the
 *   transaction that set it. A session-level `SET` would survive the
 *   checkout and is never used here.
 * - **Parameter-bound, never interpolated.** Values travel as query
 *   parameters. The format validation below is a second line of defence,
 *   not the first.
 * - **Always inside `$transaction`.** `set_config(..., true)` outside a
 *   transaction is a no-op (PostgreSQL warns and discards it), so every
 *   entry point here opens its own interactive transaction and runs the
 *   caller's work inside it, on the single pooled connection that
 *   transaction holds.
 *
 * Compatibility: when no tenant is bound, the policies permit every row
 * and application-level authorization governs exactly as before. RLS is
 * defense in depth that engages when a tenant is bound; it does not
 * replace the authorization checks in `src/common/guards`. See
 * docs/row-level-security.md.
 */
@Injectable()
export class TenantContextService {
  private readonly logger = new Logger(TenantContextService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs `fn` inside a transaction bound to one tenant.
   *
   * Every statement `fn` issues through `tx` — reads and writes alike —
   * sees only that tenant's rows on the eight protected tables (plus the
   * bypass-audit table, which is unprotected by design). Statements
   * against unprotected tables are unaffected.
   *
   * The binding is deterministic and bounded: the organization id must
   * match {@link ORGANIZATION_ID_PATTERN} (cuid/uuid characters, at most
   * 128). Anything else is rejected before any SQL runs.
   */
  async withTenantContext<T>(
    organizationId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const tenantId = validateOrganizationId(organizationId);
    this.logger.debug(`Binding tenant context organizationId=${tenantId}`);
    return this.prisma.$transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      return fn(tx);
    });
  }

  /**
   * Runs `fn` inside a transaction with the RLS bypass flag set.
   *
   * Reserved for privileged maintenance that must touch rows across
   * tenants — backfills, incident response, data repair. Narrow by
   * construction:
   *
   * - The caller must supply a non-empty, bounded `reason` and an
   *   `actor`; both are validated before any SQL runs.
   * - One append-only `RlsBypassAudit` row is written inside the same
   *   transaction as the bypassed work, so the audit record commits or
   *   rolls back with the work it authorizes. A bypass with no audit row
   *   cannot commit.
   * - The flag is transaction-local (see the class comment), so it cannot
   *   leak onto a pooled connection.
   *
   * This is the only sanctioned way to set `app.rls_bypass`. Do not set
   * the flag anywhere else, and do not call this from request handlers:
   * request paths bind a tenant instead.
   */
  async withBypassContext<T>(
    options: RlsBypassOptions,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const reason = validateBypassReason(options.reason);
    const actor = validateBypassActor(options.actor);
    const organizationId =
      options.organizationId === undefined
        ? null
        : validateOrganizationId(options.organizationId);
    this.logger.warn(
      `RLS bypass requested actor=${actor} organizationId=${organizationId ?? "none"} reason=${reason}`,
    );
    return this.prisma.$transaction(async (tx) => {
      await setBypassContext(tx, reason);
      await tx.rlsBypassAudit.create({
        data: { reason, actor, organizationId },
      });
      const result = await fn(tx);
      this.logger.warn(
        `RLS bypass completed actor=${actor} organizationId=${organizationId ?? "none"}`,
      );
      return result;
    });
  }

  /**
   * Reads back the tenant bound on this transaction, if any.
   *
   * Returns the bound organization id, or `null` when the transaction has
   * no tenant bound. Intended for tests and diagnostics; request code
   * should carry the tenant it bound rather than re-reading it.
   */
  async readTenantContext(tx: Prisma.TransactionClient): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ value: string | null }>>`
      SELECT current_setting(${RLS_TENANT_SETTING}, true) AS value
    `;
    const value = rows[0]?.value ?? null;
    return value === "" ? null : value;
  }
}

/**
 * Binds the tenant on a transaction client.
 *
 * `set_config(name, value, true)` is the parameterizable form of
 * `SET LOCAL`: the third argument makes the setting transaction-local.
 * Used instead of `SET LOCAL ... = ${value}` because `SET` does not accept
 * bind parameters, and interpolating the value would be injection-prone.
 */
async function setTenantContext(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<void> {
  await tx.$executeRaw`
    SELECT set_config(${RLS_TENANT_SETTING}, ${organizationId}, true)
  `;
}

/** Sets the bypass flag and its justification on a transaction client. */
async function setBypassContext(
  tx: Prisma.TransactionClient,
  reason: string,
): Promise<void> {
  await tx.$executeRaw`
    SELECT set_config(${RLS_BYPASS_SETTING}, ${RLS_BYPASS_ACTIVE_VALUE}, true)
  `;
  await tx.$executeRaw`
    SELECT set_config(${RLS_BYPASS_REASON_SETTING}, ${reason}, true)
  `;
}

/** Validates an organization id before it reaches SQL. */
export function validateOrganizationId(organizationId: unknown): string {
  if (typeof organizationId !== "string" || !ORGANIZATION_ID_PATTERN.test(organizationId)) {
    throw new TenantContextError(
      "organizationId must be a non-empty string of letters, digits, '-' or '_' (max 128 characters)",
    );
  }
  return organizationId;
}

/** Validates a bypass justification before it reaches SQL or the audit table. */
export function validateBypassReason(reason: unknown): string {
  if (typeof reason !== "string") {
    throw new TenantContextError("bypass reason must be a string");
  }
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new TenantContextError("bypass reason must not be empty");
  }
  if (trimmed.length > MAX_BYPASS_REASON_LENGTH) {
    throw new TenantContextError(
      `bypass reason must be at most ${MAX_BYPASS_REASON_LENGTH} characters`,
    );
  }
  if (hasControlCharacter(trimmed)) {
    throw new TenantContextError("bypass reason must not contain control characters");
  }
  return trimmed;
}

/** Validates a bypass actor identifier before it reaches SQL or the audit table. */
export function validateBypassActor(actor: unknown): string {
  if (typeof actor !== "string") {
    throw new TenantContextError("bypass actor must be a string");
  }
  const trimmed = actor.trim();
  if (trimmed.length === 0) {
    throw new TenantContextError("bypass actor must not be empty");
  }
  if (trimmed.length > MAX_BYPASS_ACTOR_LENGTH) {
    throw new TenantContextError(
      `bypass actor must be at most ${MAX_BYPASS_ACTOR_LENGTH} characters`,
    );
  }
  if (hasControlCharacter(trimmed)) {
    throw new TenantContextError("bypass actor must not contain control characters");
  }
  return trimmed;
}

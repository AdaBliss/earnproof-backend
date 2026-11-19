/**
 * Injectable wrapper around the pure tenant-context assertions.
 *
 * Services that run inside Nest's DI container inject this instead of
 * importing the pure helpers directly, so every fail-closed denial is
 * observable in one place: denied access is logged (operation,
 * resource type, and context source — never a tenant id or row content)
 * before the error propagates, and background jobs get a single entry
 * point, {@link runInTenantScope}, that validates the job's tenant
 * context before the handler — and therefore before any database access —
 * runs.
 *
 * This is the application-layer complement to database-level row-level
 * security: RLS still guards the rows in Postgres, but these checks stop
 * a missing or mismatched context from ever reaching a query.
 */
import { Injectable, Logger } from "@nestjs/common";
import {
  assertTenantIdMatches,
  assertTenantOwnership,
  assertTenantOwnershipOrNotFound,
  MissingTenantContextError,
  requireTenantContext,
  TenantAssertionOptions,
  TenantContext,
  TenantOwned,
  tenantWhere,
} from "./tenant-context";

@Injectable()
export class TenantDataAccess {
  private readonly logger = new Logger(TenantDataAccess.name);

  /** Validates a tenant context (fail closed) and returns a frozen copy. */
  requireContext(
    context: TenantContext | null | undefined,
    options?: TenantAssertionOptions,
  ): TenantContext {
    try {
      return requireTenantContext(context, options);
    } catch (error) {
      this.logDenial("tenant.context.missing", options, error);
      throw error;
    }
  }

  /** Merges a validated tenant context into a Prisma `where` input. */
  scopedWhere<T extends Record<string, unknown>>(
    context: TenantContext | null | undefined,
    extra?: T,
    options?: TenantAssertionOptions,
  ): T & { organizationId: string } {
    try {
      return tenantWhere(context, extra, options);
    } catch (error) {
      this.logDenial("tenant.ownership.mismatch", options, error);
      throw error;
    }
  }

  /** Asserts a row belongs to the tenant; mismatch throws 403. */
  assertOwned<T extends TenantOwned>(
    record: T | null | undefined,
    context: TenantContext | null | undefined,
    options?: TenantAssertionOptions,
  ): T | null | undefined {
    try {
      return assertTenantOwnership(record, context, options);
    } catch (error) {
      this.logDenial("tenant.ownership.mismatch", options, error);
      throw error;
    }
  }

  /** Read-path ownership assertion; a foreign row is reported as 404. */
  assertOwnedOrNotFound<T extends TenantOwned>(
    record: T | null | undefined,
    context: TenantContext | null | undefined,
    options?: TenantAssertionOptions,
  ): T {
    try {
      return assertTenantOwnershipOrNotFound(record, context, options);
    } catch (error) {
      // A 404 for a foreign row is information hiding, not a denial worth
      // an error log; only a missing context is logged, and only at warn.
      if (error instanceof MissingTenantContextError) {
        this.logDenial("tenant.context.missing", options, error);
      }
      throw error;
    }
  }

  /** Asserts a bare tenant id matches the context. */
  assertIdMatches(
    organizationId: string | null | undefined,
    context: TenantContext | null | undefined,
    options?: TenantAssertionOptions,
  ): void {
    try {
      assertTenantIdMatches(organizationId, context, options);
    } catch (error) {
      this.logDenial("tenant.ownership.mismatch", options, error);
      throw error;
    }
  }

  /**
   * Runs a background-job (or any tenant-scoped) handler with a validated
   * tenant context. The context is required *before* `handler` runs, so a
   * job payload without an explicit `organizationId` fails closed with
   * {@link MissingTenantContextError} and performs no data access at all.
   * The handler receives the frozen validated context.
   */
  async runInTenantScope<T>(
    context: TenantContext | null | undefined,
    options: TenantAssertionOptions,
    handler: (tenant: TenantContext) => Promise<T>,
  ): Promise<T> {
    const tenant = this.requireContext(context, options);
    return handler(tenant);
  }

  private logDenial(
    event: string,
    options: TenantAssertionOptions | undefined,
    error: unknown,
  ): void {
    this.logger.warn(
      `${event} operation=${options?.operation ?? "unknown"} ` +
        `resourceType=${options?.resourceType ?? "unknown"} ` +
        `error=${error instanceof Error ? error.name : "UnknownError"}`,
    );
  }
}

/**
 * Transaction-local database timeout enforcement.
 *
 * Applies `SET LOCAL` commands inside transactions to enforce per-workload
 * timeouts without affecting the pooled connection or other workloads.
 * Timeouts are validated on startup and rolled back cleanly on expiry.
 */

import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  WorkloadProfiles,
  WorkloadType,
  validateAllWorkloadProfiles,
} from "./workload-profiles";
import { PrismaService } from "./prisma.service";
import { Prisma } from "@prisma/client";

@Injectable()
export class DatabaseTimeoutService implements OnModuleInit {
  private readonly logger = new Logger(DatabaseTimeoutService.name);
  private workloadProfiles: WorkloadProfiles;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    // Extract and validate workload profiles from configuration
    const timeouts = this.config.get<{
      interactive: Record<string, number>;
      job: Record<string, number>;
      migration: Record<string, number>;
      report: Record<string, number>;
    }>("database.workloadTimeouts");

    if (!timeouts) {
      throw new Error(
        "database.workloadTimeouts configuration is missing or not loaded",
      );
    }

    this.workloadProfiles = {
      [WorkloadType.INTERACTIVE]: {
        statementTimeoutMs: timeouts.interactive.statementTimeoutMs,
        idleInTransactionTimeoutMs:
          timeouts.interactive.idleInTransactionTimeoutMs,
        lockTimeoutMs: timeouts.interactive.lockTimeoutMs,
      },
      [WorkloadType.JOB]: {
        statementTimeoutMs: timeouts.job.statementTimeoutMs,
        idleInTransactionTimeoutMs: timeouts.job.idleInTransactionTimeoutMs,
        lockTimeoutMs: timeouts.job.lockTimeoutMs,
      },
      [WorkloadType.MIGRATION]: {
        statementTimeoutMs: timeouts.migration.statementTimeoutMs,
        idleInTransactionTimeoutMs:
          timeouts.migration.idleInTransactionTimeoutMs,
        lockTimeoutMs: timeouts.migration.lockTimeoutMs,
      },
      [WorkloadType.REPORT]: {
        statementTimeoutMs: timeouts.report.statementTimeoutMs,
        idleInTransactionTimeoutMs:
          timeouts.report.idleInTransactionTimeoutMs,
        lockTimeoutMs: timeouts.report.lockTimeoutMs,
      },
    };
  }

  onModuleInit(): void {
    // Validate all workload profiles at startup
    try {
      validateAllWorkloadProfiles(this.workloadProfiles);
      this.logger.log(
        `Database timeout profiles validated: ` +
          Object.entries(this.workloadProfiles)
            .map(
              ([workload, profile]) =>
                `${workload}: stmt=${profile.statementTimeoutMs}ms, idle=${profile.idleInTransactionTimeoutMs}ms, lock=${profile.lockTimeoutMs}ms`,
            )
            .join("; "),
      );
    } catch (error) {
      this.logger.error(
        `Failed to validate database timeout profiles: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Applies workload timeouts to a transaction via `SET LOCAL` commands.
   *
   * The `SET LOCAL` scope ensures timeouts apply only to this transaction
   * and never leak to the pooled connection after rollback/commit.
   *
   * @param workload the workload type (determines timeout budget)
   * @param tx the Prisma transaction client
   */
  async applyWorkloadTimeouts(
    workload: WorkloadType,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const profile = this.workloadProfiles[workload];
    if (!profile) {
      throw new Error(`Unknown workload type: ${workload}`);
    }

    // Convert milliseconds to seconds (PostgreSQL uses ms for these settings in some cases,
    // but statement_timeout uses ms directly; idle_in_transaction_session_timeout uses ms;
    // lock_timeout uses ms. We'll use the ms values as-is and let PostgreSQL interpret them.)
    // Actually, PostgreSQL's SET uses integer milliseconds for these.

    try {
      // Set statement timeout (applies to all statements in transaction)
      await tx.$executeRaw`
        SET LOCAL statement_timeout = ${profile.statementTimeoutMs}
      `;

      // Set idle-in-transaction timeout
      await tx.$executeRaw`
        SET LOCAL idle_in_transaction_session_timeout = ${profile.idleInTransactionTimeoutMs}
      `;

      // Set lock timeout
      await tx.$executeRaw`
        SET LOCAL lock_timeout = ${profile.lockTimeoutMs}
      `;

      this.logger.debug(
        `Applied workload timeouts for ${workload}: stmt=${profile.statementTimeoutMs}ms, idle=${profile.idleInTransactionTimeoutMs}ms, lock=${profile.lockTimeoutMs}ms`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to apply workload timeouts for ${workload}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Returns the timeout profile for a workload.
   * Useful for testing and observability.
   *
   * @param workload the workload type
   * @returns the profile or undefined if workload is unknown
   */
  getProfile(workload: WorkloadType): WorkloadProfile | undefined {
    return this.workloadProfiles[workload];
  }

  /**
   * Returns all configured workload profiles.
   * Useful for observability and testing.
   */
  getAllProfiles(): WorkloadProfiles {
    return this.workloadProfiles;
  }
}

/** A wrapper that applies timeouts to a transaction callback. */
export interface DatabaseTimeoutContext {
  workload: WorkloadType;
  timeoutService: DatabaseTimeoutService;
}

/**
 * Helper type for a transaction callback that receives timeout context.
 */
export type TransactionWorkloadCallback<T> = (
  tx: Prisma.TransactionClient,
  context: DatabaseTimeoutContext,
) => Promise<T>;

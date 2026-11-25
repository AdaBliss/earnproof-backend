import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';

/**
 * Quarantine Cleanup Job
 *
 * Scheduled job that runs daily to clean up expired quarantine records
 * and associated temporary storage. Moves QUARANTINED records with
 * expiresAt <= now to EXPIRED state, maintaining audit trail.
 *
 * Schedule: Daily at 2 AM (02:00:00)
 * Cron expression: 0 2 * * * (configurable via env var)
 */
@Injectable()
export class QuarantineCleanupJob {
  private readonly logger = new Logger(QuarantineCleanupJob.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Execute quarantine cleanup job.
   *
   * Finds all QUARANTINED records with expiresAt <= now and transitions them
   * to EXPIRED state. Maintains audit trail by creating entries for each
   * transition. Idempotent and safe to interrupt/restart.
   *
   * Error handling: Logs failures but doesn't rethrow (job continues on next interval).
   */
  @Cron(process.env.QUARANTINE_CLEANUP_CRON || '0 2 * * *')
  async cleanupExpiredQuarantines(): Promise<void> {
    const startTime = Date.now();
    this.logger.log('Starting quarantine cleanup job');

    try {
      const now = new Date();

      // Find all QUARANTINED records that have expired
      const expiredRecords = await this.prisma.credentialQuarantine.findMany({
        where: {
          state: 'QUARANTINED',
          expiresAt: {
            lte: now,
          },
        },
        select: {
          id: true,
          organizationId: true,
          contentHash: true,
          revision: true,
        },
      });

      this.logger.log(`Found ${expiredRecords.length} expired quarantine records`);

      if (expiredRecords.length === 0) {
        this.logger.log('No expired records to clean up');
        return;
      }

      // Update each record to EXPIRED state with optimistic concurrency
      let successCount = 0;
      let conflictCount = 0;
      let failureCount = 0;

      for (const record of expiredRecords) {
        try {
          const updated = await this.prisma.credentialQuarantine.updateMany({
            where: {
              id: record.id,
              revision: record.revision, // Optimistic lock
            },
            data: {
              state: 'EXPIRED',
              revision: { increment: 1 },
            },
          });

          if (updated.count === 0) {
            this.logger.debug(
              `Concurrent modification detected for record ${record.id}; skipping`,
            );
            conflictCount++;
            continue;
          }

          successCount++;

          // Log audit entry for expiry
          await this.prisma.credentialQuarantineAudit.create({
            data: {
              quarantineId: record.id,
              organizationId: record.organizationId,
              event: 'EXPIRED',
              actor: 'system', // System job (not a user)
              actorRole: 'ADMIN',
              previousState: 'QUARANTINED',
              newState: 'EXPIRED',
              changeReason: 'Automatic expiry by cleanup job',
            },
          });
        } catch (error) {
          this.logger.error(
            `Failed to expire record ${record.id}: ${error}`,
          );
          failureCount++;
        }
      }

      const duration = Date.now() - startTime;

      this.logger.log(
        `Quarantine cleanup completed in ${duration}ms: ` +
        `${successCount} expired, ${conflictCount} conflicts, ${failureCount} failures`,
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        `Quarantine cleanup job failed after ${duration}ms: ${error}`,
      );
      // Don't rethrow; allow job to continue on next interval
    }
  }
}

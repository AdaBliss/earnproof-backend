import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { redact } from '../common/observability/redaction';

@Injectable()
export class QuarantineService {
  private readonly logger = new Logger(QuarantineService.name);

  constructor(private readonly prisma: PrismaService) {}

  async quarantineJob(input: {
    jobId: string;
    jobType: string;
    tenantId: string;
    failureClass: string;
    attemptCount: number;
    error: unknown;
  }): Promise<{ id: string }> {
    const { jobId, jobType, tenantId, failureClass, attemptCount, error } = input;

    const errorMessage = redact(
      error instanceof Error ? error.message : String(error)
    );

    const quarantineRecord = await this.prisma.quarantinedJob.create({
      data: {
        jobId,
        jobType,
        tenantId,
        failureClass,
        attemptCount,
        lastErrorMessage: errorMessage,
        status: 'QUARANTINED',
        firstFailedAt: new Date(),
        quarantinedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    this.logger.warn(
      `Job quarantined: jobId=${jobId} jobType=${jobType} reason=${failureClass}`,
      { jobId, jobType, failureClass, attemptCount }
    );

    return { id: quarantineRecord.id };
  }
}

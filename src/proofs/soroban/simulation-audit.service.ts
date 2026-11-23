import { Injectable } from "@nestjs/common";
import { StructuredLogger } from "../../common/logger";
import { PrismaService } from "../../database/prisma.service";
import {
  SimulationAuditEntry,
  SimulationAuditPort,
} from "./ports";

export type { SimulationAuditEntry } from "./ports";

/**
 * Persists privacy-safe simulation diagnostics and ties them to the
 * submission that follows. A persistence failure is logged and swallowed:
 * the audit trail must never be the reason a proof fails to anchor.
 */
@Injectable()
export class SimulationAuditService extends SimulationAuditPort {
  private readonly logger = new StructuredLogger(SimulationAuditService.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async recordSimulation(entry: SimulationAuditEntry): Promise<void> {
    try {
      await this.prisma.contractSimulationRecord.create({
        data: {
          correlationId: entry.correlationId,
          operation: entry.operation,
          proofIdHash: entry.proofIdHash,
          outcome: entry.outcome,
          reasonCode: entry.reasonCode ?? null,
          latestLedger: entry.metrics?.latestLedger ?? null,
          minResourceFee: entry.metrics?.minResourceFee ?? null,
          cpuInstructions: entry.metrics?.cpuInstructions ?? null,
          memoryBytes: entry.metrics?.memoryBytes ?? null,
          authEntryCount: entry.metrics?.authEntryCount ?? null,
          restoreRequired: entry.metrics?.restoreRequired ?? false,
        },
      });
    } catch {
      this.logger.warn(
        `Failed to persist simulation record correlation=${entry.correlationId}`,
      );
    }
  }

  async recordSubmission(
    correlationId: string,
    transactionHash: string,
  ): Promise<void> {
    try {
      await this.prisma.contractSimulationRecord.updateMany({
        where: { correlationId },
        data: { submittedTransactionHash: transactionHash, submittedAt: new Date() },
      });
    } catch {
      this.logger.warn(
        `Failed to link submission to simulation correlation=${correlationId}`,
      );
    }
  }
}

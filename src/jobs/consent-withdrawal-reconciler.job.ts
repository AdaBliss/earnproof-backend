import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Interval } from "@nestjs/schedule";
import { StructuredLogger } from "../common/logger";
import { ConsentWithdrawalService } from "../proofs/consent-withdrawal.service";

/**
 * Retries pending consent withdrawals whose contract submission has not yet
 * been confirmed.
 *
 * Bounded (the service caps each pass), idempotent (each attempt is claimed by
 * a conditional update, so overlapping runs cannot double-submit) and disabled
 * by default. Enable with CONSENT_WITHDRAWAL_RECONCILIATION_ENABLED=true.
 * Logs carry counts only.
 */
@Injectable()
export class ConsentWithdrawalReconcilerJob {
  private readonly logger = new StructuredLogger(
    ConsentWithdrawalReconcilerJob.name,
  );
  private running = false;
  private readonly enabled: boolean;

  constructor(
    private readonly withdrawals: ConsentWithdrawalService,
    config: ConfigService,
  ) {
    this.enabled =
      config.get<string>("CONSENT_WITHDRAWAL_RECONCILIATION_ENABLED", "false") ===
      "true";
  }

  @Interval(60_000)
  async run(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    try {
      const { attempted, confirmed } = await this.withdrawals.reconcilePending();
      if (attempted > 0) {
        this.logger.log("Reconciled consent withdrawals", { attempted, confirmed });
      }
    } catch (error) {
      this.logger.error("Consent withdrawal reconciliation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }
}

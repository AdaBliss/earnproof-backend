import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { IssuerKeyCompromiseResponseService } from "../issuers/issuer-key-compromise-response.service";

/**
 * Drives OPEN issuer signing key compromise incidents to CONTAINED.
 *
 * A compromise report opens the incident and revokes trust immediately;
 * this job is what finishes the response when the report itself cannot:
 * it re-runs bounded affected-record discovery, revokes any straggler
 * trust pins, verifies the key is still COMPROMISED with an unchanged
 * commitment, and records the deterministic evidence hash.
 *
 * Each pass is idempotent and reentrant: incidents are processed oldest
 * first in bounded batches, a failed incident is left OPEN for the next
 * pass (and for operator review), and overlapping passes are skipped via
 * the running flag — so the job survives timeouts, failed runs, and
 * process restarts without double-containing an incident.
 */
@Injectable()
export class IssuerKeyCompromiseResponseJob {
  private readonly logger = new Logger(IssuerKeyCompromiseResponseJob.name);
  private running = false;

  constructor(
    private readonly compromiseService: IssuerKeyCompromiseResponseService,
  ) {}

  @Interval(60_000)
  async run(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const result = await this.compromiseService.processOpenIncidents();
      if (result.contained > 0) {
        this.logger.log(
          `Contained ${result.contained} issuer key compromise incident(s) ` +
            `(${result.examined} examined, ${result.skipped} skipped)`,
        );
      }
      return result.contained;
    } catch (error) {
      this.logger.error(
        `Issuer key compromise containment failed: ${
          error instanceof Error ? error.name : "unknown"
        }`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}

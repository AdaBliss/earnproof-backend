import {
  HttpStatus,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AscendingPageOptions,
  AscendingPaymentsPage,
  HorizonClient,
  HorizonCancelledError,
  HorizonReadOptions,
  HorizonReadResult,
} from "./horizon-client";
import { HorizonTransactionRecord, NormalizedPayment } from "./stellar.types";
import { HorizonException } from "../common/exceptions/domain.exceptions";

@Injectable()
export class StellarService {
  private readonly horizonUrl: string;
  private readonly horizon: HorizonClient;

  constructor(
    configService: ConfigService,
    /**
     * Injected only by tests, which supply a scripted transport and a no-op
     * sleep. Production builds its own client from configuration.
     */
    @Optional() horizonClient?: HorizonClient,
  ) {
    this.horizonUrl = configService
      .getOrThrow<string>("stellar.horizonUrl")
      .replace(/\/$/, "");

    this.horizon = horizonClient ?? new HorizonClient({ horizonUrl: this.horizonUrl });
  }

  /**
   * Incoming payments for a wallet, newest first.
   *
   * Delegates to {@link HorizonClient}, which walks Horizon's cursors, retries
   * only transient faults, and stops at an explicit page, record, or time
   * bound. Every Horizon failure is collapsed to one dependency error here: the
   * caller is an HTTP handler that can do nothing differently for a 429 than
   * for a 503, and the fault taxonomy that distinguishes them has already done
   * its work inside the retry loop.
   */
  async fetchIncomingPayments(
    walletAddress: string,
    options: HorizonReadOptions = {},
  ): Promise<NormalizedPayment[]> {
    const result = await this.readIncomingPayments(walletAddress, options);
    return result.payments;
  }

  /**
   * The full read result, including the resume cursor and what stopped the walk.
   *
   * Separate from {@link fetchIncomingPayments} so the common caller keeps its
   * simple array contract while a caller that wants to resume, or to alert on
   * malformed records, can reach the detail.
   */
  async readIncomingPayments(
    walletAddress: string,
    options: HorizonReadOptions = {},
  ): Promise<HorizonReadResult> {
    try {
      return await this.horizon.listIncomingPayments(walletAddress, options);
    } catch (error) {
      // Cancellation is the caller's own decision, not a dependency failure;
      // reporting it as one would make a client disconnect look like a Horizon
      // outage on the dashboards.
      if (error instanceof HorizonCancelledError) throw error;

      throw new ServiceUnavailableException(
        "Stellar Horizon is temporarily unavailable",
      );
    }
  }

  /**
   * One ascending page of an account's payments after `options.cursor`, for
   * ledger-range backfills. Failures collapse to one dependency error, as for
   * the forward read.
   */
  async readPaymentsPageAscending(
    walletAddress: string,
    options: AscendingPageOptions,
  ): Promise<AscendingPaymentsPage> {
    try {
      return await this.horizon.readPaymentsPageAscending(
        walletAddress,
        options,
      );
    } catch (error) {
      if (error instanceof HorizonCancelledError) throw error;

      throw new ServiceUnavailableException(
        "Stellar Horizon is temporarily unavailable",
      );
    }
  }

  async fetchTransaction(
    transactionHash: string,
  ): Promise<HorizonTransactionRecord | null> {
    const response = await fetch(
      `${this.horizonUrl}/transactions/${encodeURIComponent(transactionHash)}`,
    );

    if (!response.ok) {
      // Never echo the response body — Horizon errors can include the raw
      // request path/params, which for this endpoint includes the
      // transaction hash but could carry more in other Horizon error shapes.
      throw new HorizonException(
        "Stellar Horizon is temporarily unavailable",
        response.status === 404
          ? HttpStatus.NOT_FOUND
          : HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const transaction = (await response.json()) as HorizonTransactionRecord;
    return transaction && typeof transaction === "object" ? transaction : null;
  }
}

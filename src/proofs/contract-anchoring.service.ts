import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { promisify } from "util";
import { sha256 } from "../common/crypto/hash";
import { redact } from "../common/observability/redaction";
import { StructuredLogger } from "../common/logger";
import { CircuitBreakerRegistry } from "../common/resilience/circuit-breaker.registry";
import {
  CircuitBreaker,
  CircuitOpenError,
  CircuitState,
} from "../common/resilience/circuit-breaker";
import {
  AnchorFailureKind,
  classifyContractError,
  classifyFailureKind,
  ContractSubmissionError,
} from "./contract-error";
import { SorobanRpcClient } from "./soroban/soroban-rpc.client";
import {
  SequenceCoordinatorPort,
  SequenceLease,
  SimulationAuditPort,
} from "./soroban/ports";
import {
  evaluateSimulation,
  isPermanentRejection,
  SimulationPolicy,
} from "./soroban/simulation-policy";
import {
  DEFAULT_FEE_POLICY,
  FeePolicy,
  assertValidFeePolicy,
  decideFee,
} from "../config/fee-policy";
import { FeeEstimator, HorizonFeeEstimator } from "../stellar/fee-estimator";
import { SorobanRpcResponseError } from "../common/validation/soroban-rpc.schemas";

const execFileAsync = promisify(execFile);

/** Prefix for per-network, per-operation contract circuit names. */
export const CONTRACT_CIRCUIT_PREFIX = "contract";

/** Contract operation classes tracked as distinct circuits. */
export type ContractOperationClass = "register" | "revoke" | "read";

export type AnchorProofInput = {
  proofId: string;
  commitment: string;
  expiresAt: Date;
};

export type AnchorProofResult =
  | {
      anchored: true;
      transactionHash: string;
    }
  | {
      anchored: false;
      /**
       * `circuit_open` means the dependency circuit refused the call before it
       * ran: the contract was never touched, the intent was not consumed, and
       * the worker should hold it for a later probe rather than count an
       * attempt against it.
       *
       * `sequence_busy` means another worker holds this source account, so
       * nothing was built or submitted; it is released the same way.
       */
      reason:
        | "disabled"
        | "failed"
        | "circuit_open"
        | "sequence_busy"
        | "fee_refused";
      error?: string;
      /**
       * Set when `reason` is `failed` and the failure is not a plain transient
       * one: how it should be retried. Absent means `transient`.
       */
      failureKind?: AnchorFailureKind;
    };

export type ContractProofStatus =
  | {
      checked: true;
      revoked: boolean;
      valid: boolean;
    }
  | {
      checked: false;
      reason: "disabled" | "failed" | "circuit_open";
      error?: string;
    };

@Injectable()
export class ContractAnchoringService {
  private readonly logger = new StructuredLogger(ContractAnchoringService.name);
  private readonly enabled: boolean;
  private readonly required: boolean;
  private readonly stellarCliPath: string;
  private readonly source: string | undefined;
  private readonly network: string;
  private readonly proofRegistryContractId: string | undefined;
  private readonly issuerAddress: string | undefined;
  private readonly schemaVersion: number;
  private readonly registry?: CircuitBreakerRegistry;
  private readonly rpc?: SorobanRpcClient;
  private readonly simulationPolicy: SimulationPolicy;
  private readonly simulationEnabled: boolean;
  private readonly feePolicy: FeePolicy;
  private readonly feeEstimator: FeeEstimator;
  private readonly breakerOptions: {
    failureThreshold?: number;
    openDurationMs?: number;
    halfOpenMaxProbes?: number;
    successThreshold?: number;
  };

  constructor(
    private readonly configService: ConfigService,
    /**
     * Optional so the existing unit tests (which construct the service with a
     * config alone) keep working. When present, every contract invocation runs
     * under a per-network, per-operation circuit breaker (issue #203).
     */
    @Optional() registry?: CircuitBreakerRegistry,
    /**
     * The three collaborators below are optional for the same reason: without
     * them the service behaves exactly as before (no preflight, no source
     * serialisation, no audit trail).
     */
    @Inject(SorobanRpcClient)
    @Optional()
    rpcOrFeeEstimator?: SorobanRpcClient | FeeEstimator,
    @Optional() private readonly sequences?: SequenceCoordinatorPort,
    @Optional() private readonly audit?: SimulationAuditPort,
    @Optional() feeEstimator?: FeeEstimator,
  ) {
    this.enabled = configService.get<boolean>("contractAnchoring.enabled") ?? false;
    this.required = configService.get<boolean>("contractAnchoring.required") ?? false;
    this.stellarCliPath =
      configService.get<string>("contractAnchoring.stellarCliPath") ?? "stellar";
    this.source = configService.get<string>("contractAnchoring.source");
    this.network = configService.get<string>("stellar.network") ?? "testnet";
    this.proofRegistryContractId = configService.get<string>(
      "contractAnchoring.proofRegistryContractId",
    );
    this.issuerAddress = configService.get<string>(
      "contractAnchoring.issuerAddress",
    );
    this.schemaVersion =
      configService.get<number>("contractAnchoring.schemaVersion") ?? 1;
    this.registry = registry;
    const thirdArgumentIsFeeEstimator = Boolean(
      rpcOrFeeEstimator &&
        "getEstimate" in rpcOrFeeEstimator &&
        !("simulateTransaction" in rpcOrFeeEstimator),
    );
    this.rpc = thirdArgumentIsFeeEstimator
      ? undefined
      : (rpcOrFeeEstimator as SorobanRpcClient | undefined);
    this.simulationPolicy = {
      maxMinResourceFee: BigInt(
        configService.get<number>("contractAnchoring.simulation.maxMinResourceFee") ??
          10_000_000,
      ),
      maxCpuInstructions: BigInt(
        configService.get<number>("contractAnchoring.simulation.maxCpuInstructions") ??
          100_000_000,
      ),
      maxMemoryBytes: BigInt(
        configService.get<number>("contractAnchoring.simulation.maxMemoryBytes") ??
          41_943_040,
      ),
      authExpiration: {
        minLedgers:
          configService.get<number>("contractAnchoring.authExpiration.minLedgers") ?? 2,
        maxLedgers:
          configService.get<number>("contractAnchoring.authExpiration.maxLedgers") ??
          17_280,
      },
    };
    this.simulationEnabled =
      (configService.get<boolean>("contractAnchoring.simulation.enabled") ?? true) &&
      Boolean(this.rpc?.configured);
    this.feePolicy = this.loadFeePolicy(configService);
    const injectedFeeEstimator = thirdArgumentIsFeeEstimator
      ? (rpcOrFeeEstimator as FeeEstimator)
      : feeEstimator;
    const estimateEnabled =
      configService.get<boolean>("contractAnchoring.fee.estimateEnabled") ?? false;
    this.feeEstimator =
      injectedFeeEstimator ??
      (estimateEnabled
        ? new HorizonFeeEstimator(
            configService.get<string>("stellar.horizonUrl") ??
              "https://horizon-testnet.stellar.org",
          )
        : { getEstimate: async () => null });
    this.breakerOptions = {
      failureThreshold: configService.get<number>(
        "contractAnchoring.circuitBreaker.failureThreshold",
      ),
      openDurationMs: configService.get<number>(
        "contractAnchoring.circuitBreaker.openDurationMs",
      ),
      halfOpenMaxProbes: configService.get<number>(
        "contractAnchoring.circuitBreaker.halfOpenMaxProbes",
      ),
      successThreshold: configService.get<number>(
        "contractAnchoring.circuitBreaker.successThreshold",
      ),
    };
  }

  private loadFeePolicy(configService: ConfigService): FeePolicy {
    const read = (key: keyof FeePolicy) =>
      configService.get<number>(`contractAnchoring.fee.${key}`) ??
      DEFAULT_FEE_POLICY[key];
    const policy: FeePolicy = {
      baseFeeStroops: read("baseFeeStroops"),
      maxFeeStroops: read("maxFeeStroops"),
      surgeThresholdStroops: read("surgeThresholdStroops"),
      surgeMultiplier: read("surgeMultiplier"),
      refusalThresholdStroops: read("refusalThresholdStroops"),
      estimateMaxAgeMs: read("estimateMaxAgeMs"),
    };
    assertValidFeePolicy(policy);
    return policy;
  }

  private async decideSubmissionFee(operation: string) {
    const estimate = await this.feeEstimator.getEstimate();
    const decision = decideFee(this.feePolicy, estimate);
    this.logger.log("Contract fee decision", {
      operation,
      action: decision.action,
      reasonCode: decision.reason,
      ...(decision.action === "submit" ? { feeStroops: decision.feeStroops } : {}),
    });
    return decision;
  }

  /**
   * State of the circuit governing a contract operation on the current network,
   * or `closed` when no breaker is wired. Read by the anchoring worker to decide
   * how many intents it may claim — see its backpressure logic.
   */
  circuitState(operation: ContractOperationClass): CircuitState {
    return this.breakerFor(operation)?.snapshot().state ?? "closed";
  }

  /** The breaker for a given network operation, created on first use. */
  private breakerFor(
    operation: ContractOperationClass,
  ): CircuitBreaker | undefined {
    return this.registry?.getOrCreate({
      name: `${CONTRACT_CIRCUIT_PREFIX}:${this.network}:${operation}`,
      ...this.breakerOptions,
    });
  }

  /**
   * Runs a CLI invocation under the operation's circuit breaker.
   *
   * When the circuit is open the breaker throws {@link CircuitOpenError} before
   * `run` executes, so the contract is never touched — the backpressure the
   * worker relies on. A permanent contract error is classified as `ignore` by
   * {@link classifyContractError} so it never opens the circuit; a transient
   * RPC/CLI failure is a `trip`.
   */
  private guarded<T>(
    operation: ContractOperationClass,
    run: () => Promise<T>,
  ): Promise<T> {
    const breaker = this.breakerFor(operation);
    if (!breaker) return run();
    return breaker.execute(run, classifyContractError);
  }

  async anchorProof(input: AnchorProofInput): Promise<AnchorProofResult> {
    if (!this.enabled || !this.hasRequiredConfig()) {
      return {
        anchored: false,
        reason: "disabled",
      };
    }

    return this.submit({
      operation: "register",
      functionName: "register_proof",
      functionArgs: [
        "--proof_id_hash",
        sha256(input.proofId),
        "--commitment_hash",
        this.hexFromSha256(input.commitment),
        "--issuer_address",
        this.issuerAddress!,
        "--schema_version",
        String(this.schemaVersion),
        "--expires_at",
        String(Math.floor(input.expiresAt.getTime() / 1000)),
      ],
      proofId: input.proofId,
      label: "Contract anchoring",
    });
  }

  /**
   * Shared handling for an open-circuit refusal.
   *
   * In `required` mode the caller (synchronous proof issuance) cannot proceed
   * without a successful anchor, so an open circuit is surfaced as an error. In
   * the default asynchronous mode the worker holds the intent for a later probe,
   * so `circuit_open` is returned without consuming an attempt.
   */
  private circuitOpenResult(
    context: string,
  ): { anchored: false; reason: "circuit_open" } {
    if (this.required) {
      throw new Error(`${context} unavailable: dependency circuit is open`);
    }
    this.logger.warn(`${context} skipped: dependency circuit is open`);
    return { anchored: false, reason: "circuit_open" };
  }

  private feeRefusedResult(
    reasonCode: string,
  ): { anchored: false; reason: "fee_refused"; error: string } {
    const message = `Contract submission refused by fee policy: ${reasonCode}`;
    if (this.required) throw new Error(message);
    this.logger.warn(message);
    return { anchored: false, reason: "fee_refused", error: message };
  }

  async revokeProof(proofId: string): Promise<AnchorProofResult> {
    if (!this.enabled || !this.hasRequiredConfig()) {
      return {
        anchored: false,
        reason: "disabled",
      };
    }

    return this.submit({
      operation: "revoke",
      functionName: "revoke_proof",
      functionArgs: ["--proof_id_hash", sha256(proofId)],
      proofId,
      label: "Contract mutation",
    });
  }

  /**
   * Records a subject's disclosure-consent withdrawal on the contract.
   *
   * Only hashes are sent: the receipt id and a commitment derived from it.
   * The call records a withdrawal; it deletes nothing, and every previously
   * anchored record stays immutable.
   */
  async withdrawDisclosureConsent(input: {
    disclosureReceiptId: string;
    withdrawalCommitment: string;
  }): Promise<AnchorProofResult> {
    if (!this.enabled || !this.hasRequiredConfig()) {
      return { anchored: false, reason: "disabled" };
    }

    return this.submit({
      operation: "revoke",
      functionName: "withdraw_disclosure_consent",
      functionArgs: [
        "--receipt_id_hash",
        sha256(input.disclosureReceiptId),
        "--withdrawal_commitment",
        this.hexFromSha256(input.withdrawalCommitment),
      ],
      proofId: input.disclosureReceiptId,
      label: "Consent withdrawal",
    });
  }

  async getProofStatus(proofId: string): Promise<ContractProofStatus> {
    if (!this.enabled || !this.hasRequiredConfig()) {
      return {
        checked: false,
        reason: "disabled",
      };
    }

    try {
      const [revoked, valid] = await Promise.all([
        this.invokeRead("is_revoked", ["--proof_id_hash", sha256(proofId)]),
        this.invokeRead("is_valid_proof", ["--proof_id_hash", sha256(proofId)]),
      ]);

      return {
        checked: true,
        revoked: this.parseBoolean(revoked),
        valid: this.parseBoolean(valid),
      };
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        if (this.required) {
          throw new Error("Contract status check unavailable: circuit is open");
        }
        this.logger.warn("Contract status check skipped: circuit is open");
        return { checked: false, reason: "circuit_open" };
      }

      const message = safeCliError(error);
      if (this.required) {
        throw new Error(message);
      }

      this.logger.warn(`Contract status check failed: ${message}`);
      return {
        checked: false,
        reason: "failed",
        error: message,
      };
    }
  }

  /**
   * Submits a state-changing contract call: serialise on the source account,
   * simulate, validate, and only then sign and submit.
   */
  private async submit(call: {
    operation: Exclude<ContractOperationClass, "read">;
    functionName: string;
    functionArgs: string[];
    proofId: string;
    label: string;
  }): Promise<AnchorProofResult> {
    const fee = await this.decideSubmissionFee(call.operation);
    if (fee.action === "refuse") return this.feeRefusedResult(fee.reason);

    let lease: SequenceLease | null = null;
    try {
      if (this.sequences) {
        lease = await this.sequences.acquire(this.source!);
        if (!lease) {
          this.logger.warn(`${call.label} deferred: source account is busy`);
          if (this.required) {
            throw new ContractSubmissionError(
              "transient",
              "sequence_busy",
              `${call.label} unavailable: source account is in use by another worker`,
              false,
            );
          }
          return { anchored: false, reason: "sequence_busy" };
        }
      }

      const transactionHash = await this.guarded(call.operation, () =>
        this.simulateThenSubmit(call, lease, fee.feeStroops),
      );
      return { anchored: true, transactionHash };
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        return this.circuitOpenResult(call.label);
      }

      const message = safeCliError(error);
      if (this.required) {
        throw error instanceof ContractSubmissionError
          ? error
          : new Error(message);
      }

      this.logger.warn(`${call.label} failed: ${message}`);
      const failureKind = classifyFailureKind(error);
      return {
        anchored: false,
        reason: "failed",
        error: message,
        // Absent means `transient`, which keeps the result shape of ordinary
        // failures unchanged for existing callers.
        ...(failureKind === "transient" ? {} : { failureKind }),
      };
    } finally {
      if (lease) await this.sequences!.release(lease);
    }
  }

  /** The part of a submission that runs under the circuit breaker. */
  private async simulateThenSubmit(
    call: { functionName: string; functionArgs: string[]; proofId: string },
    lease: SequenceLease | null,
    feeStroops: number,
  ): Promise<string> {
    const correlationId = randomUUID();

    // Everything up to and including the verdict happens before the signing
    // call below, so a rejected simulation never reaches a secret.
    await this.preflight(call, correlationId, feeStroops);

    if (lease && !(await this.sequences!.renew(lease))) {
      throw new ContractSubmissionError(
        "transient",
        "sequence_lease_lost",
        "Source-account lease expired before submission; not submitting",
        false,
      );
    }

    this.logger.log(
      `Submitting ${call.functionName} correlation=${correlationId}`,
    );
    const { stdout } = await execFileAsync(
      this.stellarCliPath,
      this.contractInvokeArgs(
        call.functionName,
        call.functionArgs,
        true,
        [],
        feeStroops,
      ),
      { windowsHide: true, timeout: 120_000 },
    );
    const transactionHash = this.lastOutputLine(stdout);
    if (this.simulationEnabled) {
      await this.audit?.recordSubmission(correlationId, transactionHash);
    }
    return transactionHash;
  }

  /**
   * Builds the transaction without signing it, simulates it on the RPC, and
   * checks the result against policy. Throws a {@link ContractSubmissionError}
   * for any outcome other than "approved" - including an unreachable or
   * malformed RPC, because submitting without a verdict would defeat the
   * preflight.
   */
  private async preflight(
    call: { functionName: string; functionArgs: string[]; proofId: string },
    correlationId: string,
    feeStroops: number,
  ): Promise<void> {
    if (!this.simulationEnabled) return;

    const { stdout } = await execFileAsync(
      this.stellarCliPath,
      this.contractInvokeArgs(call.functionName, call.functionArgs, true, [
        "--build-only",
      ], feeStroops),
      { windowsHide: true, timeout: 60_000 },
    );
    const builtXdr = this.lastOutputLine(stdout);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(builtXdr)) {
      throw new ContractSubmissionError(
        "transient",
        "malformed_simulation",
        "Contract preflight could not build a transaction",
      );
    }

    let raw: unknown;
    try {
      raw = await this.rpc!.simulateTransaction(builtXdr);
    } catch (error) {
      throw new ContractSubmissionError(
        "transient",
        "simulation_unavailable",
        `Contract preflight unavailable: ${
          error instanceof Error ? error.message : "RPC failure"
        }`,
      );
    }

    const verdict = evaluateSimulation(raw, this.simulationPolicy);
    const proofIdHash = sha256(call.proofId);
    if (verdict.status === "approved") {
      await this.audit?.recordSimulation({
        correlationId,
        operation: call.functionName,
        proofIdHash,
        outcome: "approved",
        metrics: verdict.metrics,
      });
      return;
    }

    await this.audit?.recordSimulation({
      correlationId,
      operation: call.functionName,
      proofIdHash,
      outcome: "rejected",
      reasonCode: verdict.code,
      metrics: verdict.metrics,
    });
    const permanent = isPermanentRejection(verdict.code);
    throw new ContractSubmissionError(
      permanent ? "permanent" : "transient",
      verdict.code,
      `Contract simulation rejected: ${verdict.code}`,
      // A malformed body is an RPC fault; every other rejection is an answer.
      verdict.code === "malformed_simulation",
    );
  }

  private async invokeRead(functionName: string, functionArgs: string[]) {
    const { stdout } = await this.guarded("read", () =>
      execFileAsync(
        this.stellarCliPath,
        this.contractInvokeArgs(functionName, functionArgs, false),
        {
          windowsHide: true,
          timeout: 60_000,
        },
      ),
    );
    return this.lastOutputLine(stdout);
  }

  private contractInvokeArgs(
    functionName: string,
    functionArgs: string[],
    includeSource: boolean,
    extraFlags: string[] = [],
    feeStroops?: number,
  ) {
    const args = ["contract", "invoke"];
    if (includeSource) {
      args.push("--source", this.source!);
    }
    if (feeStroops !== undefined) {
      args.push("--fee", String(feeStroops));
    }

    args.push(
      "--network",
      this.network,
      "--id",
      this.proofRegistryContractId!,
      ...extraFlags,
      "--",
      functionName,
      ...functionArgs,
    );

    return args;
  }

  private hasRequiredConfig() {
    return Boolean(
      this.source && this.proofRegistryContractId && this.issuerAddress,
    );
  }

  private hexFromSha256(value: string) {
    const normalized = value.startsWith("sha256:") ? value.slice(7) : value;
    if (!/^[a-fA-F0-9]{64}$/.test(normalized)) {
      return sha256(value);
    }

    return normalized.toLowerCase();
  }

  private lastOutputLine(stdout: string) {
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.at(-1) ?? "";
  }

  private parseBoolean(value: string) {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    throw new SorobanRpcResponseError("SOROBAN_RPC_RESPONSE_MALFORMED", "simulation", [
      "result",
    ]);
  }
}

/** Node includes execFile argv in failures, including the signing source. */
function safeCliError(error: unknown): string {
  return redact(error instanceof Error ? error.message : "Unknown error");
}

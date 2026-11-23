import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Address, xdr } from "@stellar/stellar-base";
import { StructuredLogger } from "../common/logger";
import { SorobanRpcClient } from "../proofs/soroban/soroban-rpc.client";

/**
 * Stable, safe reason codes. They are the only diagnostic that leaves this
 * service: no contract ids, hashes, URLs or passphrases are logged or returned,
 * because a mismatch report routinely ends up in tickets and chat.
 */
export type ContractIdentityReason =
  | "network_passphrase_mismatch"
  | "proof_registry_not_deployed"
  | "proof_registry_wasm_mismatch"
  | "issuer_registry_not_deployed"
  | "issuer_registry_wasm_mismatch"
  | "contracts_swapped"
  | "contract_ids_identical"
  | "rpc_unavailable"
  | "rpc_timeout"
  | "rpc_malformed";

export interface ContractIdentityState {
  /**
   * `pending` until the first check finishes. Anything other than `ok` keeps
   * readiness down.
   */
  status: "pending" | "ok" | "mismatch" | "unavailable";
  reasons: ContractIdentityReason[];
  checkedAt: string | null;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_RECHECK_MS = 5 * 60_000;
const DEFAULT_RETRY_MS = 10_000;

class IdentityCheckError extends Error {
  constructor(readonly reason: ContractIdentityReason) {
    super(reason);
  }
}

/**
 * Cross-checks, at startup and periodically after, that the configured
 * network and contracts are the ones the operator meant to talk to:
 *
 * - the RPC's network passphrase equals the configured passphrase;
 * - each configured contract id is deployed on that network;
 * - each contract's deployed WASM hash is one the operator pinned (the pin is
 *   the deployment and interface identity: a different hash is a different
 *   build and therefore a different interface);
 * - the proof registry and issuer registry have not been swapped.
 *
 * A valid-looking `C...` address proves none of this on its own.
 *
 * The check is a no-op unless anchoring is enabled and a Soroban RPC URL is
 * configured, so existing deployments are unaffected until they opt in.
 */
@Injectable()
export class ContractIdentityService implements OnApplicationBootstrap {
  private readonly logger = new StructuredLogger(ContractIdentityService.name);
  private state: ContractIdentityState = {
    status: "pending",
    reasons: [],
    checkedAt: null,
  };
  private inFlight: Promise<void> | null = null;
  private lastAttemptMs = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly rpc: SorobanRpcClient,
  ) {}

  /** True when this gate applies to the current configuration. */
  get active(): boolean {
    return (
      (this.config.get<boolean>("contractAnchoring.enabled") ?? false) &&
      (this.config.get<boolean>("contractAnchoring.identity.enabled") ?? true) &&
      this.rpc.configured
    );
  }

  onApplicationBootstrap(): void {
    if (!this.active) return;
    // Not awaited: startup must not block on the network. Readiness stays
    // down (`pending`) until this resolves.
    void this.refresh();
  }

  /**
   * The current verdict. When the verdict is due for a re-check, one is
   * started in the background (single-flighted); the caller still gets the
   * latest known state immediately, so a probe never waits on the network.
   */
  current(): ContractIdentityState {
    if (this.active && this.isStale() && !this.inFlight) {
      void this.refresh();
    }
    return this.state;
  }

  /** Runs one bounded check. Never rejects. */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.lastAttemptMs = Date.now();
    this.inFlight = this.runBounded()
      .then((next) => {
        const changed = next.status !== this.state.status;
        this.state = next;
        if (changed || next.status !== "ok") {
          this.logger.log(
            `Contract identity check: ${next.status}${
              next.reasons.length ? ` (${next.reasons.join(",")})` : ""
            }`,
          );
        }
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private isStale(): boolean {
    const interval =
      this.state.status === "ok"
        ? (this.config.get<number>("contractAnchoring.identity.recheckIntervalMs") ??
          DEFAULT_RECHECK_MS)
        : (this.config.get<number>("contractAnchoring.identity.retryIntervalMs") ??
          DEFAULT_RETRY_MS);
    return Date.now() - this.lastAttemptMs >= interval;
  }

  private async runBounded(): Promise<ContractIdentityState> {
    const timeoutMs =
      this.config.get<number>("contractAnchoring.identity.timeoutMs") ??
      DEFAULT_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new IdentityCheckError("rpc_timeout")),
        timeoutMs,
      );
    });

    try {
      const reasons = await Promise.race([this.collectMismatches(), timeout]);
      return {
        status: reasons.length === 0 ? "ok" : "mismatch",
        reasons,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: "unavailable",
        reasons: [
          error instanceof IdentityCheckError ? error.reason : "rpc_unavailable",
        ],
        checkedAt: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async collectMismatches(): Promise<ContractIdentityReason[]> {
    const reasons: ContractIdentityReason[] = [];

    const proofId = this.config.get<string>(
      "contractAnchoring.proofRegistryContractId",
    );
    const issuerEnabled =
      this.config.get<boolean>("issuerRegistry.enabled") ?? false;
    const issuerId = issuerEnabled
      ? this.config.get<string>("issuerRegistry.contractId")
      : undefined;
    const proofPins = this.pins("contractAnchoring.identity.proofRegistryWasmHashes");
    const issuerPins = this.pins("contractAnchoring.identity.issuerRegistryWasmHashes");

    if (proofId && issuerId && proofId === issuerId) {
      reasons.push("contract_ids_identical");
    }

    const expectedPassphrase = this.config.get<string>("stellar.networkPassphrase");
    const network = await this.rpcCall(() => this.rpc.getNetwork());
    const passphrase = (network as { passphrase?: unknown } | null)?.passphrase;
    if (typeof passphrase !== "string") throw new IdentityCheckError("rpc_malformed");
    if (expectedPassphrase !== undefined && passphrase !== expectedPassphrase) {
      // A different network makes every contract lookup below meaningless.
      return [...reasons, "network_passphrase_mismatch"];
    }

    const verify = async (
      contractId: string | undefined,
      own: string[],
      other: string[],
      notDeployed: ContractIdentityReason,
      mismatch: ContractIdentityReason,
    ): Promise<void> => {
      if (!contractId) return;
      const hash = await this.wasmHashOf(contractId);
      if (hash === null) {
        reasons.push(notDeployed);
      } else if (own.length > 0 && !own.includes(hash)) {
        const reason = other.includes(hash) ? "contracts_swapped" : mismatch;
        if (!reasons.includes(reason)) reasons.push(reason);
      }
    };
    await verify(
      proofId,
      proofPins,
      issuerPins,
      "proof_registry_not_deployed",
      "proof_registry_wasm_mismatch",
    );
    await verify(
      issuerId,
      issuerPins,
      proofPins,
      "issuer_registry_not_deployed",
      "issuer_registry_wasm_mismatch",
    );
    return reasons;
  }

  private pins(key: string): string[] {
    return (this.config.get<string[]>(key) ?? []).map((hash) => hash.toLowerCase());
  }

  /** @returns the lower-case hex WASM hash, or `null` if nothing is deployed. */
  private async wasmHashOf(contractId: string): Promise<string | null> {
    let key: string;
    try {
      key = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: new Address(contractId).toScAddress(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
        }),
      ).toXDR("base64");
    } catch {
      // Not a decodable contract id: it cannot be deployed anywhere.
      return null;
    }

    const result = await this.rpcCall(() => this.rpc.getLedgerEntries([key]));
    const entries = (result as { entries?: unknown } | null)?.entries;
    if (entries === null || entries === undefined) return null;
    if (!Array.isArray(entries)) throw new IdentityCheckError("rpc_malformed");
    if (entries.length === 0) return null;

    try {
      const encoded = (entries[0] as { xdr?: unknown }).xdr;
      if (typeof encoded !== "string") throw new Error("no xdr");
      const executable = xdr.LedgerEntryData.fromXDR(encoded, "base64")
        .contractData()
        .val()
        .instance()
        .executable();
      // A built-in (stellar asset) contract has no WASM hash to pin.
      return executable.switch().name === "contractExecutableWasm"
        ? executable.wasmHash().toString("hex")
        : "";
    } catch {
      throw new IdentityCheckError("rpc_malformed");
    }
  }

  private async rpcCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const failure = (error as { failure?: string }).failure;
      throw new IdentityCheckError(
        failure === "timeout"
          ? "rpc_timeout"
          : failure === "malformed"
            ? "rpc_malformed"
            : "rpc_unavailable",
      );
    }
  }
}

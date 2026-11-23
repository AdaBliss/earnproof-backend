import { ConfigService } from "@nestjs/config";
import {
  contractInstanceEntries,
  OTHER_CONTRACT_ID,
  TEST_CONTRACT_ID,
} from "../../test/fixtures/soroban-fixtures";
import {
  SorobanRpcClient,
  SorobanRpcError,
} from "../proofs/soroban/soroban-rpc.client";
import { ContractIdentityService } from "./contract-identity.service";

const PASSPHRASE = "Test SDF Network ; September 2015";
const PROOF_HASH = "a".repeat(64);
const ISSUER_HASH = "b".repeat(64);
const SECRET_URL = "https://rpc.example.invalid/?apikey=SUPERSECRETKEY";

type Entries = Record<string, string | null>;

function build(
  options: {
    config?: Record<string, unknown>;
    passphrase?: string;
    entries?: Entries;
    networkError?: Error;
    hang?: boolean;
  } = {},
) {
  const config: Record<string, unknown> = {
    "contractAnchoring.enabled": true,
    "contractAnchoring.proofRegistryContractId": TEST_CONTRACT_ID,
    "stellar.networkPassphrase": PASSPHRASE,
    "contractAnchoring.identity.timeoutMs": 200,
    "contractAnchoring.identity.proofRegistryWasmHashes": [PROOF_HASH],
    "contractAnchoring.identity.issuerRegistryWasmHashes": [ISSUER_HASH],
    ...options.config,
  };
  const entries: Entries = options.entries ?? { [TEST_CONTRACT_ID]: PROOF_HASH };
  const rpc = {
    configured: true,
    getNetwork: jest.fn(async () => {
      if (options.hang) return new Promise(() => undefined);
      if (options.networkError) throw options.networkError;
      return { passphrase: options.passphrase ?? PASSPHRASE, protocolVersion: 22 };
    }),
    getLedgerEntries: jest.fn(async (keys: string[]) => {
      // Resolve which contract the key addresses by trying each known id.
      for (const [id, hash] of Object.entries(entries)) {
        if (hash === null) continue;
        const candidate = contractInstanceEntries(id, hash) as {
          entries: { xdr: string }[];
        };
        // Keys are opaque base64; match by calling order instead.
        if (keys.length === 1 && lastRequestedId === id) return candidate;
      }
      return { latestLedger: 1, entries: null };
    }),
  };
  let lastRequestedId = "";
  const service = new ContractIdentityService(
    { get: (key: string) => config[key] } as unknown as ConfigService,
    rpc as unknown as SorobanRpcClient,
  );
  // Track which id is being asked for, in the order the service asks.
  const ids = [
    config["contractAnchoring.proofRegistryContractId"] as string | undefined,
    config["issuerRegistry.enabled"]
      ? (config["issuerRegistry.contractId"] as string | undefined)
      : undefined,
  ].filter(Boolean) as string[];
  let call = 0;
  const original = rpc.getLedgerEntries;
  rpc.getLedgerEntries = jest.fn(async (keys: string[]) => {
    lastRequestedId = ids[call++] ?? "";
    return original(keys);
  });
  return { service, rpc };
}

describe("ContractIdentityService", () => {
  it("is pending (not ready) before the first check", () => {
    const { service } = build();
    expect(service.current().status).toBe("pending");
  });

  it("is ok when the network and contract match the pinned identity", async () => {
    const { service } = build();

    await service.refresh();

    expect(service.current()).toMatchObject({ status: "ok", reasons: [] });
  });

  it("reports a wrong network and stops before inspecting contracts", async () => {
    const { service, rpc } = build({ passphrase: "Public Global Stellar Network ; September 2015" });

    await service.refresh();

    expect(service.current()).toMatchObject({
      status: "mismatch",
      reasons: ["network_passphrase_mismatch"],
    });
    expect(rpc.getLedgerEntries).not.toHaveBeenCalled();
  });

  it("reports a contract that is not deployed on this network", async () => {
    const { service } = build({ entries: { [TEST_CONTRACT_ID]: null } });

    await service.refresh();

    expect(service.current().reasons).toEqual(["proof_registry_not_deployed"]);
  });

  it("reports a deployed contract whose WASM hash is not the pinned one", async () => {
    const { service } = build({ entries: { [TEST_CONTRACT_ID]: "c".repeat(64) } });

    await service.refresh();

    expect(service.current()).toMatchObject({
      status: "mismatch",
      reasons: ["proof_registry_wasm_mismatch"],
    });
  });

  it("detects swapped contracts: proof registry id pointing at the issuer registry build", async () => {
    const { service } = build({ entries: { [TEST_CONTRACT_ID]: ISSUER_HASH } });

    await service.refresh();

    expect(service.current().reasons).toEqual(["contracts_swapped"]);
  });

  it("detects the same id configured for both registries", async () => {
    const { service } = build({
      config: {
        "issuerRegistry.enabled": true,
        "issuerRegistry.contractId": TEST_CONTRACT_ID,
      },
    });

    await service.refresh();

    expect(service.current().reasons).toContain("contract_ids_identical");
    expect(service.current().status).toBe("mismatch");
  });

  it("checks the issuer registry too, and passes when both match", async () => {
    const { service } = build({
      config: {
        "issuerRegistry.enabled": true,
        "issuerRegistry.contractId": OTHER_CONTRACT_ID,
      },
      entries: { [TEST_CONTRACT_ID]: PROOF_HASH, [OTHER_CONTRACT_ID]: ISSUER_HASH },
    });

    await service.refresh();

    expect(service.current()).toMatchObject({ status: "ok", reasons: [] });
  });

  it("accepts any hash in a pinned list (rolling upgrade)", async () => {
    const { service } = build({
      config: {
        "contractAnchoring.identity.proofRegistryWasmHashes": ["d".repeat(64), PROOF_HASH],
      },
    });

    await service.refresh();

    expect(service.current().status).toBe("ok");
  });

  describe("unavailable RPC keeps readiness down", () => {
    it("reports rpc_unavailable on a transport failure", async () => {
      const { service } = build({
        networkError: new SorobanRpcError("transport", "Soroban RPC getNetwork request failed"),
      });

      await service.refresh();

      expect(service.current()).toMatchObject({
        status: "unavailable",
        reasons: ["rpc_unavailable"],
      });
    });

    it("reports rpc_timeout when the RPC itself times out", async () => {
      const { service } = build({
        networkError: new SorobanRpcError("timeout", "timed out"),
      });

      await service.refresh();

      expect(service.current().reasons).toEqual(["rpc_timeout"]);
    });

    it("enforces its own bound when the RPC never answers", async () => {
      const { service } = build({ hang: true });

      await service.refresh();

      expect(service.current()).toMatchObject({
        status: "unavailable",
        reasons: ["rpc_timeout"],
      });
    });

    it("reports a malformed network response as unavailable, not ok", async () => {
      const { service, rpc } = build();
      rpc.getNetwork.mockResolvedValueOnce({ nothing: true });

      await service.refresh();

      expect(service.current()).toMatchObject({
        status: "unavailable",
        reasons: ["rpc_malformed"],
      });
    });

    it("recovers to ok once the RPC returns", async () => {
      const { service, rpc } = build();
      rpc.getNetwork.mockRejectedValueOnce(new SorobanRpcError("transport", "x"));

      await service.refresh();
      expect(service.current().status).toBe("unavailable");

      await service.refresh();
      expect(service.current().status).toBe("ok");
    });
  });

  describe("activation", () => {
    it("is inactive (and does not call the RPC) when anchoring is disabled", () => {
      const { service, rpc } = build({ config: { "contractAnchoring.enabled": false } });

      service.onApplicationBootstrap();

      expect(service.active).toBe(false);
      expect(rpc.getNetwork).not.toHaveBeenCalled();
    });

    it("is inactive when no Soroban RPC is configured", () => {
      const { service, rpc } = build();
      (rpc as { configured: boolean }).configured = false;

      expect(service.active).toBe(false);
    });

    it("can be switched off explicitly", () => {
      const { service } = build({
        config: { "contractAnchoring.identity.enabled": false },
      });
      expect(service.active).toBe(false);
    });

    it("starts a check at bootstrap when active", async () => {
      const { service, rpc } = build();

      service.onApplicationBootstrap();
      await service.refresh();

      expect(rpc.getNetwork).toHaveBeenCalledTimes(1);
      expect(service.current().status).toBe("ok");
    });

    it("single-flights concurrent refreshes", async () => {
      const { service, rpc } = build();

      await Promise.all([service.refresh(), service.refresh(), service.refresh()]);

      expect(rpc.getNetwork).toHaveBeenCalledTimes(1);
    });
  });

  describe("safe diagnostics", () => {
    it("never exposes contract ids, hashes, URLs or passphrases in its state", async () => {
      const { service } = build({
        config: { "contractAnchoring.sorobanRpcUrl": SECRET_URL },
        entries: { [TEST_CONTRACT_ID]: "c".repeat(64) },
        passphrase: PASSPHRASE,
      });

      await service.refresh();

      const state = JSON.stringify(service.current());
      for (const sensitive of [TEST_CONTRACT_ID, "c".repeat(64), PROOF_HASH, SECRET_URL, "SUPERSECRETKEY", PASSPHRASE]) {
        expect(state).not.toContain(sensitive);
      }
    });
  });
});

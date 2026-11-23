import { ConfigService } from "@nestjs/config";
import {
  authEntry,
  simulationResult,
  SimulationOverrides,
} from "../../test/fixtures/soroban-fixtures";
import { sha256 } from "../common/crypto/hash";
import { CircuitBreakerRegistry } from "../common/resilience/circuit-breaker.registry";
import {
  AnchorProofInput,
  ContractAnchoringService,
} from "./contract-anchoring.service";
import { ContractSubmissionError } from "./contract-error";
import {
  SequenceCoordinatorPort,
  SequenceLease,
  SimulationAuditPort,
} from "./soroban/ports";
import { SorobanRpcClient, SorobanRpcError } from "./soroban/soroban-rpc.client";

// See contract-anchoring.service.spec.ts for why execFile needs the
// `promisify.custom` symbol under test.
jest.mock("child_process", () => {
  const { promisify } = jest.requireActual("util");
  const mockExecFileCallback = jest.fn();
  function execFile(
    cmd: string,
    args: readonly string[],
    opts: unknown,
    callback: (error: Error | null, stdout: string) => void,
  ) {
    return mockExecFileCallback(cmd, args, opts, callback);
  }
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    cmd: string,
    args: readonly string[],
    opts: unknown,
  ) =>
    new Promise((resolve, reject) => {
      mockExecFileCallback(
        cmd,
        args,
        opts,
        (error: Error | null, stdout: string) => {
          if (error) reject(error);
          else resolve({ stdout, stderr: "" });
        },
      );
    });
  return { execFile, __mockExecFileCallback: mockExecFileCallback };
});

const mockExecFile = (
  jest.requireMock("child_process") as { __mockExecFileCallback: jest.Mock }
).__mockExecFileCallback;

const BUILT_XDR = "AAAAAgAAAAB0ZXN0";
const SECRET_SOURCE = "SSECRETSOURCEKEYTHATMUSTNEVERLEAKINTOLOGSORERRORS";
const TX_HASH = "abc123txhash";

const BASE_CONFIG: Record<string, unknown> = {
  "contractAnchoring.enabled": true,
  "contractAnchoring.required": false,
  "contractAnchoring.stellarCliPath": "stellar",
  "contractAnchoring.source": SECRET_SOURCE,
  "stellar.network": "testnet",
  "contractAnchoring.proofRegistryContractId": "CONTRACT_ID",
  "contractAnchoring.issuerAddress": "GISSUER",
  "contractAnchoring.schemaVersion": 1,
  "contractAnchoring.sorobanRpcUrl": "https://rpc.example.invalid",
  "contractAnchoring.simulation.maxMinResourceFee": 1_000_000,
  "contractAnchoring.simulation.maxCpuInstructions": 100_000_000,
  "contractAnchoring.simulation.maxMemoryBytes": 40_000_000,
  "contractAnchoring.authExpiration.minLedgers": 2,
  "contractAnchoring.authExpiration.maxLedgers": 100,
};

const proofInput: AnchorProofInput = {
  proofId: "proof_123",
  commitment: "sha256:" + "a".repeat(64),
  expiresAt: new Date("2027-01-01T00:00:00.000Z"),
};

interface Harness {
  service: ContractAnchoringService;
  simulate: jest.Mock;
  audit: { recordSimulation: jest.Mock; recordSubmission: jest.Mock };
  sequences: { acquire: jest.Mock; renew: jest.Mock; release: jest.Mock };
  lease: SequenceLease;
}

function harness(
  options: {
    config?: Record<string, unknown>;
    registry?: CircuitBreakerRegistry;
    withRpc?: boolean;
    simulation?: SimulationOverrides | Error;
    acquire?: SequenceLease | null;
    renew?: boolean;
  } = {},
): Harness {
  const config = { ...BASE_CONFIG, ...options.config };
  const configService = {
    get: (key: string) => config[key],
  } as unknown as ConfigService;

  const simulate = jest.fn(async () => {
    if (options.simulation instanceof Error) throw options.simulation;
    return simulationResult(options.simulation ?? {});
  });
  const rpc = {
    configured: true,
    simulateTransaction: simulate,
  } as unknown as SorobanRpcClient;

  const lease: SequenceLease = {
    accountKey: "key",
    token: "token",
    fencingCounter: 1,
    expiresAt: new Date(),
  };
  const sequences = {
    acquire: jest.fn(async () =>
      options.acquire === undefined ? lease : options.acquire,
    ),
    renew: jest.fn(async () => options.renew ?? true),
    release: jest.fn(async () => undefined),
  };
  const audit = {
    recordSimulation: jest.fn(async () => undefined),
    recordSubmission: jest.fn(async () => undefined),
  };

  const service = new ContractAnchoringService(
    configService,
    options.registry,
    options.withRpc === false ? undefined : rpc,
    sequences as unknown as SequenceCoordinatorPort,
    audit as unknown as SimulationAuditPort,
  );
  return { service, simulate, audit, sequences, lease };
}

/** Routes the CLI mock: build-only returns XDR, a real submit returns a hash. */
function cli(submit: { stdout: string } | { error: Error } = { stdout: TX_HASH }) {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      args: string[],
      _opts: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      if (args.includes("--build-only")) return callback(null, BUILT_XDR);
      if ("error" in submit) return callback(submit.error, "");
      return callback(null, submit.stdout);
    },
  );
}

const submitCalls = () =>
  mockExecFile.mock.calls.filter(([, args]) => !args.includes("--build-only"));
const buildCalls = () =>
  mockExecFile.mock.calls.filter(([, args]) => args.includes("--build-only"));

describe("ContractAnchoringService preflight and source coordination", () => {
  beforeEach(() => mockExecFile.mockReset());

  describe("simulation success", () => {
    it("simulates the unsigned transaction, then submits, and links the two", async () => {
      cli();
      const { service, simulate, audit } = harness();

      const result = await service.anchorProof(proofInput);

      expect(result).toEqual({ anchored: true, transactionHash: TX_HASH });
      expect(simulate).toHaveBeenCalledWith(BUILT_XDR);
      expect(buildCalls()).toHaveLength(1);
      expect(submitCalls()).toHaveLength(1);

      // Simulation happened strictly before the signing call.
      const order = mockExecFile.mock.calls.map(([, args]) =>
        args.includes("--build-only") ? "build" : "submit",
      );
      expect(order).toEqual(["build", "submit"]);

      const simulated = audit.recordSimulation.mock.calls[0][0];
      expect(simulated).toMatchObject({
        operation: "register_proof",
        proofIdHash: sha256("proof_123"),
        outcome: "approved",
      });
      expect(audit.recordSubmission).toHaveBeenCalledWith(
        simulated.correlationId,
        TX_HASH,
      );
    });

    it("builds with the same arguments it submits, plus only --build-only", async () => {
      cli();
      const { service } = harness();

      await service.anchorProof(proofInput);

      const buildArgs = buildCalls()[0][1] as string[];
      const submitArgs = submitCalls()[0][1] as string[];
      expect(buildArgs.filter((arg) => arg !== "--build-only")).toEqual(submitArgs);
      expect(buildArgs.indexOf("--build-only")).toBeLessThan(buildArgs.indexOf("--"));
    });

    it("also simulates revocations", async () => {
      cli();
      const { service, simulate } = harness();

      const result = await service.revokeProof("proof_123");

      expect(result).toEqual({ anchored: true, transactionHash: TX_HASH });
      expect(simulate).toHaveBeenCalledTimes(1);
      expect(buildCalls()[0][1]).toContain("revoke_proof");
    });
  });

  describe("deterministic rejection is never submitted", () => {
    it("does not submit a contract-rejected simulation and reports it permanent", async () => {
      cli();
      const { service, audit } = harness({
        simulation: { error: "HostError: Error(Contract, #3) proof_123" },
      });

      const result = await service.anchorProof(proofInput);

      expect(submitCalls()).toHaveLength(0);
      expect(result).toMatchObject({
        anchored: false,
        reason: "failed",
        failureKind: "permanent",
      });
      expect(JSON.stringify(result)).not.toContain("HostError");
      expect(audit.recordSimulation).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "rejected", reasonCode: "contract_rejected" }),
      );
      expect(audit.recordSubmission).not.toHaveBeenCalled();
    });

    it("does not submit when resource estimates exceed policy", async () => {
      cli();
      const { service } = harness({ simulation: { cpuInsns: "100000001" } });

      const result = await service.anchorProof(proofInput);

      expect(submitCalls()).toHaveLength(0);
      expect(result).toMatchObject({ failureKind: "permanent" });
      expect((result as { error: string }).error).toContain("resource_limit_exceeded");
    });

    it("does not submit an authorization entry that is valid for too long", async () => {
      cli();
      const { service } = harness({ simulation: { auth: [authEntry(5_000)] } });

      const result = await service.anchorProof(proofInput);

      expect(submitCalls()).toHaveLength(0);
      expect(result).toMatchObject({ failureKind: "permanent" });
      expect((result as { error: string }).error).toContain("auth_expiration_too_long");
    });

    it("does not submit an expired authorization entry, and allows a retry", async () => {
      cli();
      const { service } = harness({ simulation: { auth: [authEntry(900)] } });

      const result = await service.anchorProof(proofInput);

      expect(submitCalls()).toHaveLength(0);
      expect(result).toMatchObject({ anchored: false });
      expect(result).not.toHaveProperty("failureKind");
      expect((result as { error: string }).error).toContain("auth_expiration_expired");
    });
  });

  describe("non-deterministic outcomes are not submitted either", () => {
    it("does not submit when entries need restoring, and marks it retryable", async () => {
      cli();
      const { service, audit } = harness({ simulation: { restore: true } });

      const result = await service.anchorProof(proofInput);

      expect(submitCalls()).toHaveLength(0);
      expect(result).toMatchObject({ anchored: false });
      expect(result).not.toHaveProperty("failureKind");
      expect((result as { error: string }).error).toContain("restore_required");
      expect(audit.recordSimulation).toHaveBeenCalledWith(
        expect.objectContaining({
          reasonCode: "restore_required",
          metrics: expect.objectContaining({ restoreRequired: true }),
        }),
      );
    });

    it("does not submit on malformed simulation output", async () => {
      cli();
      const { service } = harness({ simulation: { raw: { nonsense: true } } });

      const result = await service.anchorProof(proofInput);

      expect(submitCalls()).toHaveLength(0);
      expect(result).toMatchObject({ anchored: false });
      expect(result).not.toHaveProperty("failureKind");
      expect((result as { error: string }).error).toContain("malformed_simulation");
    });

    it("does not submit when the unsigned transaction cannot be built", async () => {
      mockExecFile.mockImplementation(
        (_c: string, _a: string[], _o: unknown, cb: (e: Error | null, s: string) => void) =>
          cb(null, "this is not base64!"),
      );
      const { service, simulate } = harness();

      const result = await service.anchorProof(proofInput);

      expect(simulate).not.toHaveBeenCalled();
      expect(mockExecFile).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ anchored: false });
      expect(result).not.toHaveProperty("failureKind");
      expect((result as { error: string }).error).toContain("could not build a transaction");
    });

    it("fails closed when the RPC is unreachable instead of submitting blind", async () => {
      cli();
      const { service } = harness({
        simulation: new SorobanRpcError("timeout", "Soroban RPC simulateTransaction timed out after 5000ms"),
      });

      const result = await service.anchorProof(proofInput);

      expect(submitCalls()).toHaveLength(0);
      expect(result).toMatchObject({ anchored: false });
      expect(result).not.toHaveProperty("failureKind");
      expect((result as { error: string }).error).toContain("Contract preflight unavailable");
    });
  });

  describe("required mode", () => {
    it("throws a typed, permanent error for a rejected simulation", async () => {
      cli();
      const { service } = harness({
        config: { "contractAnchoring.required": true },
        simulation: { error: "boom" },
      });

      const error = await service.anchorProof(proofInput).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ContractSubmissionError);
      expect(error).toMatchObject({ kind: "permanent", code: "contract_rejected" });
      expect(submitCalls()).toHaveLength(0);
    });
  });

  describe("backwards compatibility", () => {
    it("skips the preflight entirely when no Soroban RPC is configured", async () => {
      cli();
      const { service, simulate } = harness({ withRpc: false });

      const result = await service.anchorProof(proofInput);

      expect(result).toEqual({ anchored: true, transactionHash: TX_HASH });
      expect(simulate).not.toHaveBeenCalled();
      expect(buildCalls()).toHaveLength(0);
    });

    it("skips the preflight when explicitly disabled", async () => {
      cli();
      const { service, simulate } = harness({
        config: { "contractAnchoring.simulation.enabled": false },
      });

      await service.anchorProof(proofInput);

      expect(simulate).not.toHaveBeenCalled();
      expect(buildCalls()).toHaveLength(0);
    });
  });

  describe("source-account sequence coordination", () => {
    it("does nothing and reports sequence_busy when another worker holds the account", async () => {
      cli();
      const { service, sequences } = harness({ acquire: null });

      const result = await service.anchorProof(proofInput);

      expect(result).toEqual({ anchored: false, reason: "sequence_busy" });
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(sequences.release).not.toHaveBeenCalled();
    });

    it("throws in required mode when the account is busy", async () => {
      cli();
      const { service } = harness({
        acquire: null,
        config: { "contractAnchoring.required": true },
      });

      await expect(service.anchorProof(proofInput)).rejects.toThrow(/in use/);
    });

    it("renews the lease after simulating and before submitting", async () => {
      cli();
      const { service, sequences, simulate } = harness();

      await service.anchorProof(proofInput);

      expect(sequences.renew).toHaveBeenCalledTimes(1);
      expect(simulate.mock.invocationCallOrder[0]).toBeLessThan(
        sequences.renew.mock.invocationCallOrder[0],
      );
    });

    it("does not submit if the lease was lost while simulating", async () => {
      cli();
      const { service } = harness({ renew: false });

      const result = await service.anchorProof(proofInput);

      expect(submitCalls()).toHaveLength(0);
      expect(result).toMatchObject({ anchored: false });
      expect(result).not.toHaveProperty("failureKind");
      expect((result as { error: string }).error).toContain("lease expired");
    });

    it.each([
      ["success", { stdout: TX_HASH }],
      ["a failed submission", { error: new Error("rpc down") }],
    ])("releases the lease after %s", async (_label, submit) => {
      cli(submit);
      const { service, sequences, lease } = harness();

      await service.anchorProof(proofInput);

      expect(sequences.release).toHaveBeenCalledWith(lease);
    });

    it("releases the lease after a rejected simulation", async () => {
      cli();
      const { service, sequences, lease } = harness({ simulation: { error: "no" } });

      await service.anchorProof(proofInput);

      expect(sequences.release).toHaveBeenCalledWith(lease);
    });

    it("keys the lease on the configured source", async () => {
      cli();
      const { service, sequences } = harness();

      await service.anchorProof(proofInput);

      expect(sequences.acquire).toHaveBeenCalledWith(SECRET_SOURCE);
    });
  });

  describe("sequence conflicts versus transport failures", () => {
    const seqError = () => new Error("transaction failed: tx_bad_seq");

    it("labels a bad-sequence submission as a sequence conflict", async () => {
      cli({ error: seqError() });
      const { service } = harness();

      const result = await service.anchorProof(proofInput);

      expect(result).toMatchObject({
        anchored: false,
        reason: "failed",
        failureKind: "sequence_conflict",
      });
    });

    it("labels a network failure as transient, not a sequence conflict", async () => {
      cli({ error: new Error("connect ECONNREFUSED 10.0.0.1:443") });
      const { service } = harness();

      const result = await service.anchorProof(proofInput);

      expect(result).toMatchObject({ anchored: false });
      expect(result).not.toHaveProperty("failureKind");
      expect((result as { error: string }).error).toContain("ECONNREFUSED");
    });

    it("never opens the circuit on sequence conflicts, but does on transport failures", async () => {
      const circuit = {
        "contractAnchoring.circuitBreaker.failureThreshold": 2,
        "contractAnchoring.circuitBreaker.openDurationMs": 60_000,
      };

      cli({ error: seqError() });
      const conflicts = harness({ config: circuit, registry: new CircuitBreakerRegistry() });
      for (let i = 0; i < 5; i += 1) await conflicts.service.anchorProof(proofInput);
      expect(conflicts.service.circuitState("register")).toBe("closed");

      cli({ error: new Error("connect ECONNREFUSED") });
      const transport = harness({ config: circuit, registry: new CircuitBreakerRegistry() });
      for (let i = 0; i < 2; i += 1) await transport.service.anchorProof(proofInput);
      expect(transport.service.circuitState("register")).toBe("open");
    });

    it("does not let rejected simulations or restore requirements open the circuit", async () => {
      cli();
      const circuit = {
        "contractAnchoring.circuitBreaker.failureThreshold": 2,
        "contractAnchoring.circuitBreaker.openDurationMs": 60_000,
      };
      const rejected = harness({
        config: circuit,
        registry: new CircuitBreakerRegistry(),
        simulation: { error: "no" },
      });
      for (let i = 0; i < 4; i += 1) await rejected.service.anchorProof(proofInput);
      expect(rejected.service.circuitState("register")).toBe("closed");

      const restore = harness({
        config: circuit,
        registry: new CircuitBreakerRegistry(),
        simulation: { restore: true },
      });
      for (let i = 0; i < 4; i += 1) await restore.service.anchorProof(proofInput);
      expect(restore.service.circuitState("register")).toBe("closed");
    });
  });

  describe("secret hygiene", () => {
    it("redacts the signing source from CLI failures", async () => {
      cli({
        error: new Error(
          `Command failed: stellar contract invoke --source ${SECRET_SOURCE} --network testnet`,
        ),
      });
      const { service } = harness();

      const result = await service.anchorProof(proofInput);

      expect(JSON.stringify(result)).not.toContain(SECRET_SOURCE);
    });

    it("never hands the audit trail the raw proof id, XDR, or source", async () => {
      cli();
      const { service, audit } = harness({ simulation: { auth: [authEntry(1050)] } });

      await service.anchorProof(proofInput);

      const recorded = JSON.stringify(audit.recordSimulation.mock.calls);
      expect(recorded).not.toContain("proof_123");
      expect(recorded).not.toContain(BUILT_XDR);
      expect(recorded).not.toContain(SECRET_SOURCE);
    });
  });
});

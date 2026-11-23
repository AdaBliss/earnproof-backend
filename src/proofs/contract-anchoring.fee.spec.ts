import { ConfigService } from "@nestjs/config";
import { ContractAnchoringService } from "./contract-anchoring.service";
import { FeeEstimate } from "../config/fee-policy";

// Same promisify-aware child_process mock as contract-anchoring.service.spec.ts.
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
      mockExecFileCallback(cmd, args, opts, (error: Error | null, stdout: string) => {
        if (error) reject(error);
        else resolve({ stdout, stderr: "" });
      });
    });

  return { execFile, __mockExecFileCallback: mockExecFileCallback };
});

const mockExecFile = (
  jest.requireMock("child_process") as { __mockExecFileCallback: jest.Mock }
).__mockExecFileCallback;

const BASE_CONFIG: Record<string, unknown> = {
  "contractAnchoring.enabled": true,
  "contractAnchoring.required": false,
  "contractAnchoring.source": "SOURCE_ACCOUNT",
  "stellar.network": "testnet",
  "contractAnchoring.proofRegistryContractId": "CONTRACT_ID",
  "contractAnchoring.issuerAddress": "GISSUER",
  "contractAnchoring.fee.baseFeeStroops": 100,
  "contractAnchoring.fee.maxFeeStroops": 5_000,
  "contractAnchoring.fee.surgeThresholdStroops": 1_000,
  "contractAnchoring.fee.surgeMultiplier": 2,
  "contractAnchoring.fee.refusalThresholdStroops": 20_000,
  "contractAnchoring.fee.estimateMaxAgeMs": 60_000,
};

function build(
  estimate: FeeEstimate | null,
  overrides: Record<string, unknown> = {},
) {
  const config = { ...BASE_CONFIG, ...overrides };
  const configService = {
    get: (key: string) => config[key],
  } as unknown as ConfigService;
  return new ContractAnchoringService(configService, undefined, {
    getEstimate: async () => estimate,
  });
}

const fresh = (feeStroops: number): FeeEstimate => ({ feeStroops, observedAt: new Date() });

function succeedOnce() {
  mockExecFile.mockImplementationOnce(
    (_c: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) =>
      cb(null, "TXHASH"),
  );
}

function feeArg(callIndex = 0): string {
  const args = mockExecFile.mock.calls[callIndex][1] as string[];
  return args[args.indexOf("--fee") + 1];
}

const proofInput = {
  proofId: "proof_123",
  commitment: "sha256:" + "a".repeat(64),
  expiresAt: new Date("2027-01-01T00:00:00.000Z"),
};

describe("ContractAnchoringService fee policy", () => {
  beforeEach(() => mockExecFile.mockReset());

  it("submits at the estimate in normal conditions", async () => {
    succeedOnce();
    await build(fresh(400)).anchorProof(proofInput);
    expect(feeArg()).toBe("400");
  });

  it("submits at the base fee when no estimate is available", async () => {
    succeedOnce();
    await build(null).anchorProof(proofInput);
    expect(feeArg()).toBe("100");
  });

  it("applies the surge multiplier", async () => {
    succeedOnce();
    await build(fresh(1_500)).anchorProof(proofInput);
    expect(feeArg()).toBe("3000");
  });

  it("never exceeds the configured ceiling under surge", async () => {
    succeedOnce();
    await build(fresh(4_000)).anchorProof(proofInput);
    expect(feeArg()).toBe("5000");
  });

  it("falls back to the base fee for a stale estimate", async () => {
    succeedOnce();
    const stale = { feeStroops: 4_000, observedAt: new Date(Date.now() - 10 * 60_000) };
    await build(stale).anchorProof(proofInput);
    expect(feeArg()).toBe("100");
  });

  it("applies the same policy to revocations", async () => {
    succeedOnce();
    await build(fresh(4_000)).revokeProof("proof_123");
    expect(feeArg()).toBe("5000");
  });

  it("refuses without touching the contract when the estimate is over the refusal threshold", async () => {
    const result = await build(fresh(25_000)).anchorProof(proofInput);
    expect(result).toMatchObject({ anchored: false, reason: "fee_refused" });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("refuses revocations the same way", async () => {
    const result = await build(fresh(25_000)).revokeProof("proof_123");
    expect(result).toMatchObject({ anchored: false, reason: "fee_refused" });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("surfaces a refusal as an error when anchoring is required", async () => {
    await expect(
      build(fresh(25_000), { "contractAnchoring.required": true }).anchorProof(proofInput),
    ).rejects.toThrow(/fee policy: refused_over_threshold/);
  });

  it("does not put fees on read-only status checks", async () => {
    mockExecFile.mockImplementation(
      (_c: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) =>
        cb(null, "false"),
    );
    await build(fresh(400)).getProofStatus("proof_123");
    for (const call of mockExecFile.mock.calls) {
      expect(call[1]).not.toContain("--fee");
    }
  });

  it("fails construction (startup) on an invalid fee configuration", () => {
    expect(() =>
      build(null, {
        "contractAnchoring.fee.baseFeeStroops": 9_000,
        "contractAnchoring.fee.maxFeeStroops": 1_000,
      }),
    ).toThrow(/Invalid fee policy/);
  });

  it("uses safe defaults when no fee configuration is present", async () => {
    succeedOnce();
    const config: Record<string, unknown> = { ...BASE_CONFIG };
    for (const key of Object.keys(config)) {
      if (key.startsWith("contractAnchoring.fee.")) delete config[key];
    }
    const service = new ContractAnchoringService(
      { get: (key: string) => config[key] } as unknown as ConfigService,
      undefined,
      { getEstimate: async () => null },
    );
    await service.anchorProof(proofInput);
    expect(feeArg()).toBe("100");
  });
});

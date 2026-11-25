import { ConfigService } from "@nestjs/config";
import { ContractAnchoringService } from "./contract-anchoring.service";
import { CircuitBreakerRegistry } from "../common/resilience/circuit-breaker.registry";
import { runWithRequestSignal } from "../common/request-context/request-abort";

// Same promisify contract as contract-anchoring.service.spec.ts: the mocked
// execFile exposes `util.promisify.custom` so the service gets `{ stdout }`.
jest.mock("child_process", () => {
  const { promisify } = jest.requireActual("util");
  const mockExecFileCallback = jest.fn();
  function execFile(cmd: string, args: readonly string[], opts: unknown, cb: unknown) {
    return mockExecFileCallback(cmd, args, opts, cb);
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
  "contractAnchoring.stellarCliPath": "stellar",
  "contractAnchoring.source": "SECRET_SOURCE_ALIAS",
  "stellar.network": "testnet",
  "contractAnchoring.proofRegistryContractId": "CONTRACT_ID",
  "contractAnchoring.issuerAddress": "GISSUER",
  "contractAnchoring.schemaVersion": 1,
};

function build(overrides: Record<string, unknown> = {}, registry?: CircuitBreakerRegistry) {
  const config = { ...BASE_CONFIG, ...overrides };
  return new ContractAnchoringService(
    { get: (key: string) => config[key] } as unknown as ConfigService,
    registry,
  );
}

const input = {
  proofId: "proof_1",
  commitment: "sha256:" + "a".repeat(64),
  expiresAt: new Date("2027-01-01T00:00:00.000Z"),
};

type Callback = (error: Error | null, stdout: string) => void;

function abortError() {
  return Object.assign(
    new Error("The operation was aborted: stellar --source SECRET_SOURCE_ALIAS"),
    { name: "AbortError", code: "ABORT_ERR" },
  );
}

/** A CLI that hangs until its signal aborts, like a real child killed by `signal`. */
function hangUntilAborted() {
  mockExecFile.mockImplementationOnce(
    (_c: string, _a: string[], opts: { signal?: AbortSignal }, cb: Callback) => {
      opts.signal?.addEventListener("abort", () => cb(abortError(), ""), { once: true });
    },
  );
}

describe("ContractAnchoringService deadlines and cancellation", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  it("hands the CLI an abort signal and no longer relies on a bare timeout", async () => {
    mockExecFile.mockImplementationOnce(
      (_c: string, _a: string[], opts: Record<string, unknown>, cb: Callback) => {
        expect(opts.signal).toBeInstanceOf(AbortSignal);
        expect(opts).not.toHaveProperty("timeout");
        cb(null, "tx_hash\n");
      },
    );

    await expect(build().anchorProof(input)).resolves.toEqual({
      anchored: true,
      transactionHash: "tx_hash",
    });
  });

  it("aborts the CLI and reports a timeout when the per-operation deadline elapses", async () => {
    let seen: AbortSignal | undefined;
    mockExecFile.mockImplementationOnce(
      (_c: string, _a: string[], opts: { signal: AbortSignal }, cb: Callback) => {
        seen = opts.signal;
        opts.signal.addEventListener("abort", () => cb(abortError(), ""), { once: true });
      },
    );

    const pending = build({ "contractAnchoring.deadlines.registerMs": 2_000 }).anchorProof(input);
    await jest.advanceTimersByTimeAsync(1_999);
    expect(seen?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    const result = await pending;
    expect(seen?.aborted).toBe(true);
    expect(result).toMatchObject({ anchored: false, reason: "timeout" });
  });

  it("never leaks CLI argv or the signing source in the abort error", async () => {
    hangUntilAborted();
    const pending = build({ "contractAnchoring.deadlines.registerMs": 1_000 }).anchorProof(input);
    await jest.advanceTimersByTimeAsync(1_000);

    const result = await pending;
    expect(JSON.stringify(result)).not.toContain("SECRET_SOURCE_ALIAS");
    expect(result).toMatchObject({ error: "Contract submission exceeded its 1000ms deadline" });
  });

  it("clamps an out-of-range deadline into the 1s..300s bounds", async () => {
    // 5ms configured: clamped up to 1s, so it is NOT aborted at 5ms.
    hangUntilAborted();
    const low = build({ "contractAnchoring.deadlines.registerMs": 5 }).anchorProof(input);
    let lowSettled = false;
    void low.then(() => (lowSettled = true));
    await jest.advanceTimersByTimeAsync(999);
    expect(lowSettled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(low).resolves.toMatchObject({ reason: "timeout" });

    // 1e12 configured: clamped down to 300s.
    hangUntilAborted();
    const high = build({ "contractAnchoring.deadlines.registerMs": 1e12 }).anchorProof(input);
    let highSettled = false;
    void high.then(() => (highSettled = true));
    await jest.advanceTimersByTimeAsync(299_999);
    expect(highSettled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(high).resolves.toMatchObject({ reason: "timeout" });
  });

  it("applies independent deadlines to revoke and read", async () => {
    const service = build({
      "contractAnchoring.deadlines.registerMs": 300_000,
      "contractAnchoring.deadlines.revokeMs": 1_000,
      "contractAnchoring.deadlines.readMs": 2_000,
    });

    hangUntilAborted();
    const revoke = service.revokeProof("proof_1");
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(revoke).resolves.toMatchObject({ anchored: false, reason: "timeout" });

    hangUntilAborted();
    hangUntilAborted();
    const status = service.getProofStatus("proof_1");
    await jest.advanceTimersByTimeAsync(2_000);
    await expect(status).resolves.toMatchObject({ checked: false, reason: "timeout" });
  });

  it("reports cancelled, not failed, when the caller signal aborts", async () => {
    hangUntilAborted();
    const controller = new AbortController();
    const pending = build().anchorProof(input, { signal: controller.signal });
    controller.abort();

    await expect(pending).resolves.toMatchObject({ anchored: false, reason: "cancelled" });
  });

  it("does not start the CLI at all for an already-cancelled caller", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await build().revokeProof("proof_1", { signal: controller.signal });

    expect(result).toMatchObject({ anchored: false, reason: "cancelled" });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("suppresses a late success: a CLI that returns after the abort is never anchored", async () => {
    const controller = new AbortController();
    mockExecFile.mockImplementationOnce(
      (_c: string, _a: string[], _o: unknown, cb: Callback) => {
        // The abort lands in the same tick the child reports success.
        controller.abort();
        cb(null, "tx_late\n");
      },
    );

    const result = await build().anchorProof(input, { signal: controller.signal });

    expect(result.anchored).toBe(false);
    expect(result).toMatchObject({ reason: "cancelled" });
    expect(JSON.stringify(result)).not.toContain("tx_late");
  });

  it("suppresses a late status read instead of reporting stale state", async () => {
    const controller = new AbortController();
    mockExecFile.mockImplementation(
      (_c: string, _a: string[], _o: unknown, cb: Callback) => {
        controller.abort();
        cb(null, "true\n");
      },
    );

    const result = await build().getProofStatus("proof_1", { signal: controller.signal });

    expect(result).toMatchObject({ checked: false, reason: "cancelled" });
  });

  it("propagates the enclosing request signal without any signature change", async () => {
    hangUntilAborted();
    const request = new AbortController();
    const pending = runWithRequestSignal(request.signal, () => build().anchorProof(input));
    request.abort();

    await expect(pending).resolves.toMatchObject({ anchored: false, reason: "cancelled" });
  });

  it("throws in required mode for a deadline, so synchronous issuance fails closed", async () => {
    hangUntilAborted();
    const pending = build({
      "contractAnchoring.required": true,
      "contractAnchoring.deadlines.registerMs": 1_000,
    }).anchorProof(input);
    const assertion = expect(pending).rejects.toThrow("exceeded its 1000ms deadline");
    await jest.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  describe("circuit breaker interaction", () => {
    const breakerConfig = {
      "contractAnchoring.circuitBreaker.failureThreshold": 1,
      "contractAnchoring.circuitBreaker.openDurationMs": 60_000,
    };

    it("counts a deadline as a dependency failure", async () => {
      hangUntilAborted();
      const service = build(
        { ...breakerConfig, "contractAnchoring.deadlines.registerMs": 1_000 },
        new CircuitBreakerRegistry(),
      );
      const pending = service.anchorProof(input);
      await jest.advanceTimersByTimeAsync(1_000);
      await pending;

      expect(service.circuitState("register")).toBe("open");
    });

    it("does not count a caller cancellation against the dependency", async () => {
      hangUntilAborted();
      const service = build(breakerConfig, new CircuitBreakerRegistry());
      const controller = new AbortController();
      const pending = service.anchorProof(input, { signal: controller.signal });
      controller.abort();
      await pending;

      expect(service.circuitState("register")).toBe("closed");
    });
  });
});

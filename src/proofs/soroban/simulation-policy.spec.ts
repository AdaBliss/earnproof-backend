import {
  authEntry,
  simulationResult,
} from "../../../test/fixtures/soroban-fixtures";
import {
  evaluateSimulation,
  extractAuthExpirations,
  isPermanentRejection,
  SimulationPolicy,
  validateAuthExpirations,
} from "./simulation-policy";

const POLICY: SimulationPolicy = {
  maxMinResourceFee: 1_000_000n,
  maxCpuInstructions: 100_000_000n,
  maxMemoryBytes: 40_000_000n,
  authExpiration: { minLedgers: 2, maxLedgers: 100 },
};

describe("evaluateSimulation", () => {
  describe("success", () => {
    it("approves a within-policy simulation and reports metrics only", () => {
      const verdict = evaluateSimulation(simulationResult(), POLICY);

      expect(verdict).toEqual({
        status: "approved",
        metrics: {
          latestLedger: 1000,
          minResourceFee: "100000",
          cpuInstructions: "5000000",
          memoryBytes: "1000000",
          authEntryCount: 0,
          restoreRequired: false,
        },
      });
    });

    it("approves entries whose expiration is inside the window", () => {
      const verdict = evaluateSimulation(
        simulationResult({ auth: [authEntry(1050)] }),
        POLICY,
      );
      expect(verdict.status).toBe("approved");
    });

    it("ignores source-account credentials, which carry no expiration", () => {
      const verdict = evaluateSimulation(
        simulationResult({ auth: [authEntry(0, "source")] }),
        POLICY,
      );
      expect(verdict.status).toBe("approved");
    });
  });

  describe("deterministic contract rejection", () => {
    it("rejects a simulation error and never leaks its message", () => {
      const verdict = evaluateSimulation(
        simulationResult({ error: "HostError: secret-arg=SABC proof_123" }),
        POLICY,
      );

      expect(verdict).toEqual({ status: "rejected", code: "contract_rejected" });
      expect(JSON.stringify(verdict)).not.toContain("SABC");
    });
  });

  describe("restore requirement", () => {
    it("rejects with restore_required and exposes the flag in metrics", () => {
      const verdict = evaluateSimulation(
        simulationResult({ restore: true }),
        POLICY,
      );

      expect(verdict).toMatchObject({
        status: "rejected",
        code: "restore_required",
        metrics: { restoreRequired: true },
      });
    });
  });

  describe("malformed output", () => {
    it.each([
      ["null", null],
      ["a string", "nope"],
      ["an array", []],
      ["an empty object", {}],
      ["missing cost", { ...(simulationResult() as object), cost: undefined }],
      [
        "non-numeric fee",
        { ...(simulationResult() as object), minResourceFee: "12abc" },
      ],
      [
        "negative cpu",
        {
          ...(simulationResult() as object),
          cost: { cpuInsns: "-1", memBytes: "1" },
        },
      ],
      [
        "two results",
        {
          ...(simulationResult() as object),
          results: [{ auth: [] }, { auth: [] }],
        },
      ],
      [
        "non-string auth entry",
        { ...(simulationResult() as object), results: [{ auth: [42] }] },
      ],
      ["undecodable auth entry", simulationResult({ auth: ["!!not-xdr!!"] })],
    ])("rejects %s as malformed", (_label, raw) => {
      expect(evaluateSimulation(raw, POLICY)).toMatchObject({
        status: "rejected",
        code: "malformed_simulation",
      });
    });
  });

  describe("resource bounds", () => {
    it.each([
      ["fee", { minResourceFee: "1000001" }],
      ["cpu", { cpuInsns: "100000001" }],
      ["memory", { memBytes: "40000001" }],
    ])("rejects %s one over the ceiling", (_label, override) => {
      expect(evaluateSimulation(simulationResult(override), POLICY)).toMatchObject(
        { status: "rejected", code: "resource_limit_exceeded" },
      );
    });

    it.each([
      ["fee", { minResourceFee: "1000000" }],
      ["cpu", { cpuInsns: "100000000" }],
      ["memory", { memBytes: "40000000" }],
    ])("accepts %s exactly at the ceiling", (_label, override) => {
      expect(evaluateSimulation(simulationResult(override), POLICY).status).toBe(
        "approved",
      );
    });

    it("does not lose precision on values beyond 2^53", () => {
      const verdict = evaluateSimulation(
        simulationResult({ cpuInsns: "9007199254740993" }),
        POLICY,
      );
      expect(verdict).toMatchObject({ code: "resource_limit_exceeded" });
    });
  });

  describe("authorization expiration window (latestLedger = 1000)", () => {
    const verdictFor = (expiration: number) =>
      evaluateSimulation(simulationResult({ auth: [authEntry(expiration)] }), POLICY);

    it("rejects an already-expired entry", () => {
      expect(verdictFor(999)).toMatchObject({ code: "auth_expiration_expired" });
    });

    it("accepts the last valid ledger only if the window allows 0 remaining", () => {
      // remaining = 0 < min (2): too short, not expired.
      expect(verdictFor(1000)).toMatchObject({ code: "auth_expiration_too_short" });
    });

    it("rejects one ledger under the minimum and accepts exactly the minimum", () => {
      expect(verdictFor(1001)).toMatchObject({ code: "auth_expiration_too_short" });
      expect(verdictFor(1002).status).toBe("approved");
    });

    it("accepts exactly the maximum and rejects one ledger over", () => {
      expect(verdictFor(1100).status).toBe("approved");
      expect(verdictFor(1101)).toMatchObject({ code: "auth_expiration_too_long" });
    });

    it("rejects when any one of several entries is out of window", () => {
      const verdict = evaluateSimulation(
        simulationResult({ auth: [authEntry(1050), authEntry(5000)] }),
        POLICY,
      );
      expect(verdict).toMatchObject({ code: "auth_expiration_too_long" });
    });
  });
});

describe("validateAuthExpirations (ledger advancement)", () => {
  const window = { minLedgers: 2, maxLedgers: 100 };

  it("is a pure function of ledger numbers: same entry, advancing ledger", () => {
    const expiration = 1050;
    expect(validateAuthExpirations([expiration], 1000, window)).toBeUndefined();
    expect(validateAuthExpirations([expiration], 1048, window)).toBeUndefined();
    expect(validateAuthExpirations([expiration], 1049, window)).toBe(
      "auth_expiration_too_short",
    );
    expect(validateAuthExpirations([expiration], 1051, window)).toBe(
      "auth_expiration_expired",
    );
  });

  it("treats the expiration ledger itself as the last valid ledger", () => {
    expect(
      validateAuthExpirations([1000], 1000, { minLedgers: 0, maxLedgers: 10 }),
    ).toBeUndefined();
    expect(
      validateAuthExpirations([1000], 1001, { minLedgers: 0, maxLedgers: 10 }),
    ).toBe("auth_expiration_expired");
  });

  it("accepts an empty set", () => {
    expect(validateAuthExpirations([], 1000, window)).toBeUndefined();
  });
});

describe("extractAuthExpirations", () => {
  it("returns only address-credential expirations", () => {
    expect(
      extractAuthExpirations([authEntry(10), authEntry(0, "source"), authEntry(20)]),
    ).toEqual([10, 20]);
  });

  it("fails closed on undecodable input", () => {
    expect(extractAuthExpirations(["garbage"])).toBeUndefined();
  });
});

describe("isPermanentRejection", () => {
  it("quarantines deterministic rejections and retries state-dependent ones", () => {
    expect(isPermanentRejection("contract_rejected")).toBe(true);
    expect(isPermanentRejection("resource_limit_exceeded")).toBe(true);
    expect(isPermanentRejection("auth_expiration_too_long")).toBe(true);
    expect(isPermanentRejection("restore_required")).toBe(false);
    expect(isPermanentRejection("malformed_simulation")).toBe(false);
    expect(isPermanentRejection("auth_expiration_expired")).toBe(false);
    expect(isPermanentRejection("auth_expiration_too_short")).toBe(false);
  });
});

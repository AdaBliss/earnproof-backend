import {
  classifyContractError,
  classifyFailureKind,
  ContractSubmissionError,
  isSequenceConflict,
} from "./contract-error";

describe("sequence conflict classification", () => {
  it.each([
    "transaction failed: tx_bad_seq",
    "Error: txBadSeq",
    "op failed with bad sequence number",
  ])("recognises %s", (message) => {
    expect(isSequenceConflict(message)).toBe(true);
  });

  it.each([
    "connect ECONNREFUSED 10.0.0.1:443",
    "request timed out",
    "tx_insufficient_balance",
  ])("does not mistake %s for a sequence conflict", (message) => {
    expect(isSequenceConflict(message)).toBe(false);
  });

  it("separates sequence conflicts from transport and permanent failures", () => {
    expect(classifyFailureKind(new Error("tx_bad_seq"))).toBe("sequence_conflict");
    expect(classifyFailureKind(new Error("ETIMEDOUT"))).toBe("transient");
    expect(classifyFailureKind(new Error("proof already registered"))).toBe("permanent");
  });

  it("never lets a sequence conflict trip the circuit, but lets transport do so", () => {
    expect(classifyContractError(new Error("tx_bad_seq"))).toBe("ignore");
    expect(classifyContractError(new Error("ETIMEDOUT"))).toBe("trip");
  });

  it("honours the typed error's own kind and dependency-fault flag", () => {
    const state = new ContractSubmissionError("transient", "restore_required", "x", false);
    const rpcFault = new ContractSubmissionError("transient", "simulation_unavailable", "x");
    const rejected = new ContractSubmissionError("permanent", "contract_rejected", "x");

    expect(classifyFailureKind(state)).toBe("transient");
    expect(classifyContractError(state)).toBe("ignore");
    expect(classifyContractError(rpcFault)).toBe("trip");
    expect(classifyContractError(rejected)).toBe("ignore");
  });
});

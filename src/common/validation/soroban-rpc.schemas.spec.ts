import {
  SOROBAN_RPC_LIMITS,
  SorobanRpcResponseError,
  parseSorobanRpcResponse,
  unwrapSorobanRpcEnvelope,
} from "./soroban-rpc.schemas";

const HASH = "a".repeat(64);

const validTransaction = {
  status: "SUCCESS",
  latestLedger: 1200,
  oldestLedger: 1000,
  ledger: 1190,
  txHash: HASH,
  resultXdr: "AAAA",
};

const validSimulation = {
  latestLedger: 1200,
  minResourceFee: "58181",
  transactionData: "AAAA",
  results: [{ auth: ["AAAA"], xdr: "AAAA" }],
  events: ["AAAA"],
};

const validEvent = {
  type: "contract",
  ledger: 1190,
  id: "0000005111-0000000001",
  contractId: "CABC",
  topic: ["AAAA"],
  value: "AAAA",
  inSuccessfulContractCall: true,
  txHash: HASH,
};

const validEvents = { latestLedger: 1200, events: [validEvent], cursor: "c1" };

function rejection(fn: () => unknown): SorobanRpcResponseError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SorobanRpcResponseError);
    return error as SorobanRpcResponseError;
  }
  throw new Error("expected a SorobanRpcResponseError");
}

describe("parseSorobanRpcResponse", () => {
  describe("valid responses", () => {
    it("accepts a transaction response", () => {
      expect(parseSorobanRpcResponse("transaction", validTransaction)).toEqual(
        validTransaction,
      );
    });

    it("accepts a NOT_FOUND transaction with only the required fields", () => {
      expect(
        parseSorobanRpcResponse("transaction", {
          status: "NOT_FOUND",
          latestLedger: 5,
        }).status,
      ).toBe("NOT_FOUND");
    });

    it("accepts a simulation response", () => {
      expect(parseSorobanRpcResponse("simulation", validSimulation)).toEqual(
        validSimulation,
      );
    });

    it("accepts a failed simulation that reports only an error", () => {
      expect(
        parseSorobanRpcResponse("simulation", {
          latestLedger: 1,
          error: "HostError",
        }).error,
      ).toBe("HostError");
    });

    it("accepts an events response", () => {
      expect(parseSorobanRpcResponse("events", validEvents)).toEqual(
        validEvents,
      );
    });

    it("accepts an empty events page", () => {
      expect(
        parseSorobanRpcResponse("events", { latestLedger: 1, events: [] })
          .events,
      ).toEqual([]);
    });
  });

  describe("forward compatibility", () => {
    it("accepts and drops unknown additive fields at every level", () => {
      const parsed = parseSorobanRpcResponse("events", {
        ...validEvents,
        newTopLevelField: { nested: true },
        events: [{ ...validEvent, futureField: 7 }],
      });

      expect(parsed).toEqual(validEvents);
      expect(parsed).not.toHaveProperty("newTopLevelField");
      expect(parsed.events[0]).not.toHaveProperty("futureField");
    });

    it("tolerates unknown transaction fields", () => {
      expect(() =>
        parseSorobanRpcResponse("transaction", {
          ...validTransaction,
          feeBump: false,
          createdAt: "1700000000",
        }),
      ).not.toThrow();
    });
  });

  describe("missing fields", () => {
    it("rejects a transaction without status", () => {
      const rest: Record<string, unknown> = { ...validTransaction };
      delete rest.status;
      const error = rejection(() => parseSorobanRpcResponse("transaction", rest));
      expect(error.code).toBe("SOROBAN_RPC_RESPONSE_MALFORMED");
      expect(error.kind).toBe("transaction");
      expect(error.paths).toContain("status");
    });

    it("rejects an event without a txHash", () => {
      const rest: Record<string, unknown> = { ...validEvent };
      delete rest.txHash;
      const error = rejection(() =>
        parseSorobanRpcResponse("events", { ...validEvents, events: [rest] }),
      );
      expect(error.paths).toContain("events.0.txHash");
    });

    it("rejects an events response without an events array", () => {
      expect(
        rejection(() =>
          parseSorobanRpcResponse("events", { latestLedger: 1 }),
        ).paths,
      ).toContain("events");
    });

    it.each([null, undefined, "text", 42, []])(
      "rejects a non-object response (%p)",
      (payload) => {
        expect(
          rejection(() => parseSorobanRpcResponse("simulation", payload)).code,
        ).toBe("SOROBAN_RPC_RESPONSE_MALFORMED");
      },
    );
  });

  describe("wrong types and values", () => {
    it("rejects a string latestLedger", () => {
      expect(
        rejection(() =>
          parseSorobanRpcResponse("transaction", {
            ...validTransaction,
            latestLedger: "1200",
          }),
        ).paths,
      ).toContain("latestLedger");
    });

    it("rejects a negative or fractional ledger", () => {
      expect(() =>
        parseSorobanRpcResponse("transaction", {
          ...validTransaction,
          latestLedger: -1,
        }),
      ).toThrow(SorobanRpcResponseError);
      expect(() =>
        parseSorobanRpcResponse("transaction", {
          ...validTransaction,
          latestLedger: 1.5,
        }),
      ).toThrow(SorobanRpcResponseError);
    });

    it("rejects an unknown transaction status", () => {
      expect(() =>
        parseSorobanRpcResponse("transaction", {
          ...validTransaction,
          status: "PENDING",
        }),
      ).toThrow(SorobanRpcResponseError);
    });

    it("rejects a malformed transaction hash", () => {
      expect(() =>
        parseSorobanRpcResponse("transaction", {
          ...validTransaction,
          txHash: "not-a-hash",
        }),
      ).toThrow(SorobanRpcResponseError);
    });

    it("rejects a non-boolean inSuccessfulContractCall", () => {
      expect(() =>
        parseSorobanRpcResponse("events", {
          ...validEvents,
          events: [{ ...validEvent, inSuccessfulContractCall: "true" }],
        }),
      ).toThrow(SorobanRpcResponseError);
    });

    it("rejects a non-numeric minResourceFee", () => {
      expect(() =>
        parseSorobanRpcResponse("simulation", {
          ...validSimulation,
          minResourceFee: "12abc",
        }),
      ).toThrow(SorobanRpcResponseError);
    });

    it("rejects an unknown event type", () => {
      expect(() =>
        parseSorobanRpcResponse("events", {
          ...validEvents,
          events: [{ ...validEvent, type: "mystery" }],
        }),
      ).toThrow(SorobanRpcResponseError);
    });
  });

  describe("oversized responses", () => {
    it("rejects a single field beyond the field limit", () => {
      const error = rejection(() =>
        parseSorobanRpcResponse("transaction", {
          ...validTransaction,
          resultXdr: "A".repeat(SOROBAN_RPC_LIMITS.maxFieldLength + 1),
        }),
      );
      expect(error.code).toBe("SOROBAN_RPC_RESPONSE_MALFORMED");
    });

    it("accepts a field exactly at the field limit", () => {
      expect(() =>
        parseSorobanRpcResponse("transaction", {
          ...validTransaction,
          resultXdr: "A".repeat(SOROBAN_RPC_LIMITS.maxFieldLength),
        }),
      ).not.toThrow();
    });

    it("rejects more topics than the limit", () => {
      expect(() =>
        parseSorobanRpcResponse("events", {
          ...validEvents,
          events: [
            {
              ...validEvent,
              topic: Array(SOROBAN_RPC_LIMITS.maxTopics + 1).fill("AAAA"),
            },
          ],
        }),
      ).toThrow(SorobanRpcResponseError);
    });

    it("rejects a response beyond the total size budget", () => {
      const fieldSized = "A".repeat(SOROBAN_RPC_LIMITS.maxFieldLength);
      const error = rejection(() =>
        parseSorobanRpcResponse("simulation", {
          latestLedger: 1,
          // 9 x 256 KiB exceeds the 2 MiB budget while each field is legal.
          events: Array(9).fill(fieldSized),
        }),
      );
      expect(error.code).toBe("SOROBAN_RPC_RESPONSE_TOO_LARGE");
    });

    it("rejects a circular payload instead of throwing a TypeError", () => {
      const circular: Record<string, unknown> = { latestLedger: 1 };
      circular.self = circular;
      expect(
        rejection(() => parseSorobanRpcResponse("simulation", circular)).code,
      ).toBe("SOROBAN_RPC_RESPONSE_TOO_LARGE");
    });
  });

  describe("payload privacy", () => {
    it("never includes received values in the error message", () => {
      const secret = "SECRET-RESULT-PAYLOAD";
      const error = rejection(() =>
        parseSorobanRpcResponse("transaction", {
          status: secret,
          latestLedger: secret,
          resultXdr: secret,
        }),
      );

      expect(error.message).not.toContain(secret);
      expect(JSON.stringify(error.paths)).not.toContain(secret);
    });
  });
});

describe("unwrapSorobanRpcEnvelope", () => {
  it("returns the validated result", () => {
    expect(
      unwrapSorobanRpcEnvelope("transaction", {
        jsonrpc: "2.0",
        id: 1,
        result: validTransaction,
      }),
    ).toEqual(validTransaction);
  });

  it("surfaces a reported RPC error as a stable code without its message", () => {
    const error = rejection(() =>
      unwrapSorobanRpcEnvelope("events", {
        error: { code: -32602, message: "startLedger leaked-detail" },
      }),
    );
    expect(error.code).toBe("SOROBAN_RPC_REPORTED_ERROR");
    expect(error.message).not.toContain("leaked-detail");
  });

  it("treats a malformed error object as malformed", () => {
    expect(
      rejection(() =>
        unwrapSorobanRpcEnvelope("events", { error: { code: "x" } }),
      ).code,
    ).toBe("SOROBAN_RPC_RESPONSE_MALFORMED");
  });

  it("rejects an envelope with neither result nor error", () => {
    expect(
      rejection(() => unwrapSorobanRpcEnvelope("simulation", { id: 1 })).paths,
    ).toContain("result");
  });

  it("rejects a non-object envelope", () => {
    expect(() => unwrapSorobanRpcEnvelope("events", "oops")).toThrow(
      SorobanRpcResponseError,
    );
  });
});

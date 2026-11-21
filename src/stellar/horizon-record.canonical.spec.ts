import { normalizeRecord, parseLedgerSequence } from "./horizon-client";

const ADDRESS = "GDESTINATIONADDRESS";

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: "8589934593",
    paging_token: "8589934593",
    type: "payment",
    to: ADDRESS,
    from: "GSOURCEADDRESS",
    transaction_hash: "a".repeat(64),
    amount: "10.0000000",
    asset_type: "credit_alphanum4",
    asset_code: "USDC",
    asset_issuer: "GISSUER",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("payment indexing amount handling", () => {
  it("persists the canonical seven-decimal form", () => {
    const outcome = normalizeRecord(payment({ amount: "10.5" }), ADDRESS);
    expect(outcome).toMatchObject({ amount: "10.5000000" });
  });

  it("keeps already canonical amounts unchanged", () => {
    expect(normalizeRecord(payment(), ADDRESS)).toMatchObject({ amount: "10.0000000" });
  });

  it("accepts the largest representable amount", () => {
    expect(normalizeRecord(payment({ amount: "922337203685.4775807" }), ADDRESS)).toMatchObject({
      amount: "922337203685.4775807",
    });
  });

  it.each([
    "1e3",
    "-0",
    "-0.0000000",
    "-1.0000000",
    "1,5",
    "1.00000001",
    "NaN",
    "Infinity",
    "",
    " 1",
    "922337203685.4775808",
    "007.0000000",
  ])("treats %p as a malformed record, never persisted", (amount) => {
    expect(normalizeRecord(payment({ amount }), ADDRESS)).toBe("malformed");
  });

  it.each([1, null, undefined, {}])("treats non-string amount %p as malformed", (amount) => {
    expect(normalizeRecord(payment({ amount }), ADDRESS)).toBe("malformed");
  });
});

describe("parseLedgerSequence", () => {
  it("accepts canonical integer strings and numbers within the safe range", () => {
    expect(parseLedgerSequence("50000000")).toBe(50_000_000);
    expect(parseLedgerSequence(50_000_000)).toBe(50_000_000);
    expect(parseLedgerSequence(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    "9007199254740992",
    "9007199254740993",
    "18446744073709551616",
    "1e3",
    "0x10",
    "-5",
    "1.5",
    "",
    " 7",
    "007",
    NaN,
    Infinity,
    2 ** 53,
    null,
    undefined,
    {},
  ])("rejects %p explicitly", (value) => {
    expect(parseLedgerSequence(value)).toBeNull();
  });
});

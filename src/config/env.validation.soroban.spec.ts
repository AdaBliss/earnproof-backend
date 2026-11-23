import { validateEnv } from "./env.validation";

/** Validation of the Soroban preflight, sequence-lease and identity settings. */
describe("validateEnv Soroban anchoring settings", () => {
  // Synthetic placeholders only.
  const baseEnv = {
    DATABASE_URL: "postgresql://user:password@localhost:5432/earnproof",
    REDIS_URL: "redis://localhost:6379",
    SESSION_SECRET: "session_secret_123",
    CREDENTIAL_SIGNING_SECRET: "credential_secret_123",
    PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  };

  it("applies documented defaults and leaves the RPC unset", () => {
    const env = validateEnv(baseEnv);

    expect(env).toMatchObject({
      CONTRACT_SIMULATION_ENABLED: "true",
      CONTRACT_SIMULATION_MAX_CPU_INSTRUCTIONS: 100_000_000,
      CONTRACT_AUTH_EXPIRATION_MIN_LEDGERS: 2,
      CONTRACT_AUTH_EXPIRATION_MAX_LEDGERS: 17_280,
      CONTRACT_SEQUENCE_LEASE_TTL_MS: 150_000,
      CONTRACT_IDENTITY_CHECK_ENABLED: "true",
    });
    expect(env.SOROBAN_RPC_URL).toBeUndefined();
  });

  it("treats empty optional values as unset", () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        SOROBAN_RPC_URL: "",
        PROOF_REGISTRY_EXPECTED_WASM_HASHES: "",
      }),
    ).not.toThrow();
  });

  it("accepts a comma-separated list of 64-char hex hashes", () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        PROOF_REGISTRY_EXPECTED_WASM_HASHES: `${"a".repeat(64)}, ${"B".repeat(64)}`,
      }),
    ).not.toThrow();
  });

  it.each([
    ["a malformed RPC URL", { SOROBAN_RPC_URL: "not a url" }, /SOROBAN_RPC_URL/],
    [
      "a short WASM hash",
      { PROOF_REGISTRY_EXPECTED_WASM_HASHES: "abc123" },
      /WASM hashes/,
    ],
    [
      "a lease TTL shorter than one submission attempt",
      { CONTRACT_SEQUENCE_LEASE_TTL_MS: "60000" },
      /CONTRACT_SEQUENCE_LEASE_TTL_MS/,
    ],
    [
      "a negative minimum auth window",
      { CONTRACT_AUTH_EXPIRATION_MIN_LEDGERS: "-1" },
      /CONTRACT_AUTH_EXPIRATION_MIN_LEDGERS/,
    ],
  ])("rejects %s", (_label, overrides, message) => {
    expect(() => validateEnv({ ...baseEnv, ...overrides })).toThrow(message);
  });
});

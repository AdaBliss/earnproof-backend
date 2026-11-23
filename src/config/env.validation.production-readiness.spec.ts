import { validateEnv } from "./env.validation";

/** Validation for the clock skew, metric rollup, config rollout and payment rotation settings. */
describe("validateEnv production-readiness settings", () => {
  // Synthetic placeholders only.
  const baseEnv = {
    DATABASE_URL: "postgresql://user:password@localhost:5432/earnproof",
    REDIS_URL: "redis://localhost:6379",
    SESSION_SECRET: "session_secret_123",
    CREDENTIAL_SIGNING_SECRET: "credential_secret_123",
    PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  };

  it("applies documented defaults", () => {
    expect(validateEnv(baseEnv)).toMatchObject({
      CLOCK_SKEW_UNKNOWN_POLICY: "fail_open",
      CLOCK_SKEW_READINESS_IMPACT: "critical",
      CLOCK_SKEW_WARN_MS: 2_000,
      CLOCK_SKEW_CRITICAL_MS: 10_000,
      METRICS_ROLLUP_RAW_RETENTION_HOURS: 6,
      METRICS_ROLLUP_DAY_RETENTION_DAYS: 730,
      PAYMENT_ACCOUNT_ROTATION_CHALLENGE_TTL_MS: 600_000,
      TRUST_PROXY_HOPS: 0,
      TRUSTED_PROXY_CIDRS: [],
    });
  });

  it("treats empty optional rollout settings as unset", () => {
    expect(() =>
      validateEnv({ ...baseEnv, DEPLOYMENT_ENVIRONMENT: "", CONFIG_SNAPSHOT_SIGNING_SECRET: "" }),
    ).not.toThrow();
  });

  it.each([
    ["negative proxy hops", { TRUST_PROXY_HOPS: "-1" }, /TRUST_PROXY_HOPS/],
    ["too many proxy hops", { TRUST_PROXY_HOPS: "11" }, /TRUST_PROXY_HOPS/],
    ["malformed proxy CIDR", { TRUSTED_PROXY_CIDRS: "not-a-cidr" }, /TRUSTED_PROXY_CIDRS/],
    ["empty proxy CIDR entry", { TRUSTED_PROXY_CIDRS: "192.0.2.0/24," }, /TRUSTED_PROXY_CIDRS/],
    ["proxy ranges without hops", { TRUSTED_PROXY_CIDRS: "192.0.2.0/24" }, /TRUSTED_PROXY_CIDRS requires TRUST_PROXY_HOPS/],
    ["hops without proxy ranges", { TRUST_PROXY_HOPS: "1" }, /TRUST_PROXY_HOPS greater than 0 requires TRUSTED_PROXY_CIDRS/],
    ["critical at or below warn", { CLOCK_SKEW_WARN_MS: "5000", CLOCK_SKEW_CRITICAL_MS: "5000" }, /CLOCK_SKEW_CRITICAL_MS/],
    ["sample age shorter than the interval", { CLOCK_SKEW_INTERVAL_MS: "120000", CLOCK_SKEW_MAX_SAMPLE_AGE_MS: "60000" }, /CLOCK_SKEW_MAX_SAMPLE_AGE_MS/],
    ["an unknown unknown-time policy", { CLOCK_SKEW_UNKNOWN_POLICY: "ignore" }, /CLOCK_SKEW_UNKNOWN_POLICY/],
    ["minute retention not exceeding hour retention", { METRICS_ROLLUP_MINUTE_RETENTION_DAYS: "5", METRICS_ROLLUP_HOUR_RETENTION_DAYS: "5" }, /retention must increase/],
    ["stages not ending at 100", { CONFIG_ROLLOUT_DEFAULT_STAGES: "5,50" }, /CONFIG_ROLLOUT_DEFAULT_STAGES/],
    ["non-increasing stages", { CONFIG_ROLLOUT_DEFAULT_STAGES: "50,25,100" }, /CONFIG_ROLLOUT_DEFAULT_STAGES/],
    ["a non-slug environment", { DEPLOYMENT_ENVIRONMENT: "Prod East" }, /DEPLOYMENT_ENVIRONMENT/],
    ["a short snapshot signing secret", { CONFIG_SNAPSHOT_SIGNING_SECRET: "short" }, /CONFIG_SNAPSHOT_SIGNING_SECRET/],
    ["a challenge TTL under a minute", { PAYMENT_ACCOUNT_ROTATION_CHALLENGE_TTL_MS: "1000" }, /PAYMENT_ACCOUNT_ROTATION_CHALLENGE_TTL_MS/],
  ])("rejects %s", (_label, overrides, message) => {
    expect(() => validateEnv({ ...baseEnv, ...overrides })).toThrow(message);
  });

  it("accepts a bounded proxy hop count with IPv4 and IPv6 CIDRs", () => {
    expect(
      validateEnv({
        ...baseEnv,
        TRUST_PROXY_HOPS: "2",
        TRUSTED_PROXY_CIDRS: "192.0.2.0/24,2001:db8::/32",
      }),
    ).toMatchObject({
      TRUST_PROXY_HOPS: 2,
      TRUSTED_PROXY_CIDRS: ["192.0.2.0/24", "2001:db8::/32"],
    });
  });

  it.each([
    ["wildcard", "*"],
    ["path", "https://app.example.com/dashboard"],
    ["query", "https://app.example.com?next=/dashboard"],
    ["fragment", "https://app.example.com#dashboard"],
    ["credentials", "https://user:pass@app.example.com"],
    ["non-web scheme", "file://app.example.com"],
  ])("rejects APP_URL containing a %s instead of one exact origin", (_label, APP_URL) => {
    expect(() => validateEnv({ ...baseEnv, APP_URL })).toThrow(/APP_URL/);
  });

  it("never echoes the snapshot signing secret in an error", () => {
    const secret = "tiny-secret";
    try {
      validateEnv({ ...baseEnv, CONFIG_SNAPSHOT_SIGNING_SECRET: secret });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(secret);
    }
  });
});

import { xdr } from "@stellar/stellar-base";

/**
 * Pure evaluation of a Soroban `simulateTransaction` response.
 *
 * Everything here is deterministic and side-effect free: the caller supplies
 * the RPC payload and a policy, and gets back a verdict. Keeping it pure is
 * what lets the boundary behaviour (exact ledger windows, exact resource
 * ceilings) be tested without an RPC node, a clock, or a signing key.
 */

export interface AuthExpirationPolicy {
  /** Minimum ledgers an entry must still be valid for (inclusive). */
  minLedgers: number;
  /** Maximum ledgers an entry may be valid for (inclusive). */
  maxLedgers: number;
}

export interface SimulationPolicy {
  /** Ceiling for `minResourceFee`, in stroops. */
  maxMinResourceFee: bigint;
  /** Ceiling for estimated CPU instructions. */
  maxCpuInstructions: bigint;
  /** Ceiling for estimated memory, in bytes. */
  maxMemoryBytes: bigint;
  authExpiration: AuthExpirationPolicy;
}

/** Privacy-safe numbers extracted from a simulation. Never contains XDR. */
export interface SimulationMetrics {
  latestLedger: number;
  minResourceFee: string;
  cpuInstructions: string;
  memoryBytes: string;
  authEntryCount: number;
  restoreRequired: boolean;
}

export type SimulationRejectionCode =
  | "contract_rejected"
  | "resource_limit_exceeded"
  | "restore_required"
  | "malformed_simulation"
  | "auth_expiration_expired"
  | "auth_expiration_too_short"
  | "auth_expiration_too_long";

export type SimulationVerdict =
  | { status: "approved"; metrics: SimulationMetrics }
  | {
      status: "rejected";
      code: SimulationRejectionCode;
      metrics?: SimulationMetrics;
    };

/**
 * Rejections that will repeat identically on every retry: the contract itself
 * said no, the call is too expensive for policy, or the entry grants authority
 * for longer than policy allows. These are quarantined, never retried.
 *
 * The remaining codes depend on moving state (archived entries, the ledger
 * advancing, an RPC node returning a bad body) and are safe to retry after a
 * fresh simulation.
 */
const PERMANENT_REJECTIONS: ReadonlySet<SimulationRejectionCode> = new Set([
  "contract_rejected",
  "resource_limit_exceeded",
  "auth_expiration_too_long",
]);

export function isPermanentRejection(code: SimulationRejectionCode): boolean {
  return PERMANENT_REJECTIONS.has(code);
}

const UINT_PATTERN = /^\d{1,30}$/;

function parseUint(value: unknown): bigint | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
  }
  if (typeof value === "string" && UINT_PATTERN.test(value)) {
    return BigInt(value);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extracts the expiration ledger of every address-credentialed authorization
 * entry. Source-account credentials carry no expiration (they ride the
 * transaction's own validity) and are skipped.
 *
 * @returns the expiration ledgers, or `undefined` if any entry cannot be
 *          decoded (fail closed: an undecodable entry is not trusted).
 */
export function extractAuthExpirations(
  authEntries: readonly string[],
): number[] | undefined {
  const expirations: number[] = [];
  for (const encoded of authEntries) {
    try {
      const entry = xdr.SorobanAuthorizationEntry.fromXDR(encoded, "base64");
      const credentials = entry.credentials();
      if (
        credentials.switch().value ===
        xdr.SorobanCredentialsType.sorobanCredentialsAddress().value
      ) {
        expirations.push(credentials.address().signatureExpirationLedger());
      }
    } catch {
      return undefined;
    }
  }
  return expirations;
}

/**
 * Validates authorization-entry expiration ledgers against the current ledger.
 *
 * A Soroban signature is valid while `currentLedger <= expirationLedger`, so
 * `remaining = expiration - current` is `0` on the last valid ledger and
 * negative once expired. The window is inclusive at both ends:
 * `remaining === minLedgers` and `remaining === maxLedgers` are accepted.
 *
 * Uses ledger numbers, never wall-clock time, so the result is identical on
 * every worker regardless of clock skew.
 */
export function validateAuthExpirations(
  expirations: readonly number[],
  currentLedger: number,
  policy: AuthExpirationPolicy,
): SimulationRejectionCode | undefined {
  for (const expiration of expirations) {
    const remaining = expiration - currentLedger;
    if (remaining < 0) return "auth_expiration_expired";
    if (remaining < policy.minLedgers) return "auth_expiration_too_short";
    if (remaining > policy.maxLedgers) return "auth_expiration_too_long";
  }
  return undefined;
}

/**
 * Judges a raw `simulateTransaction` result. Order matters and is fail-closed:
 * malformed -> contract error -> restore -> resources -> authorization.
 */
export function evaluateSimulation(
  raw: unknown,
  policy: SimulationPolicy,
): SimulationVerdict {
  const malformed: SimulationVerdict = {
    status: "rejected",
    code: "malformed_simulation",
  };
  if (!isRecord(raw)) return malformed;

  // A contract/host error is the deterministic "no" the issue asks us to
  // distinguish from transport failure. The message is deliberately dropped:
  // it can echo arguments, so only the stable code leaves this function.
  if (raw.error !== undefined) {
    return { status: "rejected", code: "contract_rejected" };
  }

  const latestLedger = parseUint(raw.latestLedger);
  const minResourceFee = parseUint(raw.minResourceFee);
  const cost = raw.cost;
  if (
    latestLedger === undefined ||
    minResourceFee === undefined ||
    !isRecord(cost) ||
    typeof raw.transactionData !== "string" ||
    !Array.isArray(raw.results) ||
    raw.results.length !== 1
  ) {
    return malformed;
  }
  const cpu = parseUint(cost.cpuInsns);
  const memory = parseUint(cost.memBytes);
  if (cpu === undefined || memory === undefined) return malformed;

  const result: unknown = raw.results[0];
  if (!isRecord(result)) return malformed;
  const auth: unknown = result.auth ?? [];
  if (!Array.isArray(auth) || !auth.every((a) => typeof a === "string")) {
    return malformed;
  }

  const restoreRequired = raw.restorePreamble !== undefined;
  const metrics: SimulationMetrics = {
    latestLedger: Number(latestLedger),
    minResourceFee: minResourceFee.toString(),
    cpuInstructions: cpu.toString(),
    memoryBytes: memory.toString(),
    authEntryCount: auth.length,
    restoreRequired,
  };

  if (restoreRequired) {
    return { status: "rejected", code: "restore_required", metrics };
  }

  if (
    minResourceFee > policy.maxMinResourceFee ||
    cpu > policy.maxCpuInstructions ||
    memory > policy.maxMemoryBytes
  ) {
    return { status: "rejected", code: "resource_limit_exceeded", metrics };
  }

  const expirations = extractAuthExpirations(auth as string[]);
  if (expirations === undefined) {
    return { status: "rejected", code: "malformed_simulation", metrics };
  }
  const authRejection = validateAuthExpirations(
    expirations,
    metrics.latestLedger,
    policy.authExpiration,
  );
  if (authRejection) {
    return { status: "rejected", code: authRejection, metrics };
  }

  return { status: "approved", metrics };
}

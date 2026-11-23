import { CallOutcome } from "../common/resilience/circuit-breaker";

/**
 * Error-message substrings that indicate a *permanent* contract failure.
 *
 * A permanent error is our-fault or a settled on-chain fact — the proof is
 * already registered, the contract id is wrong, the caller is unauthorized. It
 * will never succeed on a retry, so it must be *quarantined* (failed and left
 * alone), never retried. Critically for the circuit breaker, a permanent error
 * also says nothing about whether the RPC/CLI dependency is healthy: the
 * dependency answered, and gave a definitive no. Counting it toward opening the
 * circuit would take a working dependency offline because a caller sent an
 * already-registered proof.
 *
 * Matched case-insensitively against the *sanitised* error text.
 */
export const PERMANENT_CONTRACT_ERROR_PATTERNS: readonly RegExp[] = [
  /already registered/i,
  /already exists/i,
  /proof not found/i,
  /invalid contract id/i,
  /contract not found/i,
  /unauthorized/i,
  /access denied/i,
];

/**
 * Substrings of a Stellar submission error that mean the transaction's
 * sequence number was stale or already used (`tx_bad_seq`). This says nothing
 * about network health: the node answered, and the answer is "rebuild against
 * the current sequence". It is retried quickly and never trips the circuit.
 */
export const SEQUENCE_CONFLICT_PATTERNS: readonly RegExp[] = [
  /tx_bad_seq/i,
  /txBadSeq/,
  /bad[_ ]seq(uence)?/i,
];

/** True when a submission error is a stale or reused sequence number. */
export function isSequenceConflict(message: string): boolean {
  return SEQUENCE_CONFLICT_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * How a failed anchoring attempt should be retried.
 * - `permanent`: will repeat identically; quarantine.
 * - `sequence_conflict`: retry soon against a fresh sequence.
 * - `transient`: transport or dependency trouble; retry with backoff.
 */
export type AnchorFailureKind = "permanent" | "sequence_conflict" | "transient";

/**
 * A failure raised by this service itself (as opposed to the CLI). Its message
 * is a fixed, safe string and carries no argument, key, or RPC detail.
 */
export class ContractSubmissionError extends Error {
  constructor(
    readonly kind: AnchorFailureKind,
    readonly code: string,
    message: string,
    /**
     * Whether this reflects an unhealthy dependency (RPC down, garbage
     * response) and so should count toward opening the circuit. A retryable
     * state problem such as an archived entry does not.
     */
    readonly dependencyFault: boolean = kind === "transient",
  ) {
    super(message);
    this.name = "ContractSubmissionError";
  }
}

/** Maps any thrown error to a retry kind. */
export function classifyFailureKind(error: unknown): AnchorFailureKind {
  if (error instanceof ContractSubmissionError) return error.kind;
  const message = error instanceof Error ? error.message : String(error);
  if (isSequenceConflict(message)) return "sequence_conflict";
  return isPermanentContractError(message) ? "permanent" : "transient";
}

/** True when a contract error is permanent and must be quarantined, not retried. */
export function isPermanentContractError(message: string): boolean {
  return PERMANENT_CONTRACT_ERROR_PATTERNS.some((pattern) =>
    pattern.test(message),
  );
}

/**
 * Circuit-breaker classification for a thrown contract-invocation error.
 *
 * Permanent errors are `ignore`d — they are settled outcomes, not dependency
 * ill-health. Everything else (an RPC timeout, a CLI that could not reach the
 * network, a transient node failure) is a `trip`: those are exactly the
 * repeated failures that would otherwise exhaust the anchoring workers.
 */
export function classifyContractError(error: unknown): CallOutcome {
  // Permanent rejections and sequence conflicts are answers from a healthy
  // dependency, so they never count toward opening the circuit.
  if (error instanceof ContractSubmissionError) {
    return error.dependencyFault ? "trip" : "ignore";
  }
  return classifyFailureKind(error) === "transient" ? "trip" : "ignore";
}

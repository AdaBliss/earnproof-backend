/**
 * Recovery from Stellar account sequence desynchronization.
 *
 * An external submission or a failed transaction can advance the source
 * account's sequence number so that the next submission is rejected as
 * `tx_bad_seq`. That is neither a poison input nor a chain verdict on the
 * intent: the intent may be retried, but only after authoritative state is
 * refreshed and only when doing so cannot duplicate an already-submitted intent.
 */

/** Maximum reconciliation rounds for one intent before the divergence is terminal. */
export const SEQUENCE_RECOVERY_MAX_ATTEMPTS = 3;

/** Base delay between reconciliation rounds; scaled per round and jittered. */
export const SEQUENCE_RECOVERY_BASE_DELAY_MS = 500;

const BAD_SEQUENCE_PATTERNS: readonly RegExp[] = [
  /tx_?bad_?seq/i,
  /bad[\s_-]?sequence/i,
  /sequence number does not match/i,
];

/** True when sanitised error text reports a stale/mismatched account sequence. */
export function isBadSequenceError(message: string): boolean {
  return BAD_SEQUENCE_PATTERNS.some((pattern) => pattern.test(message));
}

/** Bounded recovery could not restore a consistent sequence: a terminal state. */
export class SequenceDivergenceError extends Error {
  constructor(readonly attempts: number) {
    super(
      `Stellar account sequence stayed desynchronized after ${attempts} reconciliation attempt(s)`,
    );
    this.name = "SequenceDivergenceError";
  }
}

/**
 * Serializes recovery so concurrent intents that hit the same stale sequence
 * reconcile one at a time instead of racing each other into new bad-sequence
 * failures. A rejected run never blocks the ones queued behind it.
 */
export class SequenceRecoveryGate {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** Delay before reconciliation round `round` (1-based), with jitter in [0.5, 1). */
export function sequenceRecoveryDelayMs(
  round: number,
  baseMs: number = SEQUENCE_RECOVERY_BASE_DELAY_MS,
  random: () => number = Math.random,
): number {
  if (baseMs <= 0) return 0;
  return Math.round(baseMs * round * (0.5 + random() * 0.5));
}

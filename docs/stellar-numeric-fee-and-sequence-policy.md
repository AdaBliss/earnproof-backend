# Stellar amounts, large counters, fees, and sequence recovery

## Canonical amounts (`src/common/validation/stellar-amount.ts`)

One parser and formatter decides every Stellar amount: Horizon payment
ingestion, proof evaluation (minimum income, income range, invoice settlement,
aggregate earnings) and DTO validation.

- Accepted: `0` or `[1-9][0-9]*`, optionally followed by `.` and 1 to 7 ASCII digits.
- Rejected: exponent notation, any sign (including negative zero), more than 7
  fractional digits, locale separators (`1,5`, `1 000`), leading zeros, bare or
  trailing points, `NaN`/`Infinity`, whitespace, and anything above the signed
  64-bit stroop limit (`922337203685.4775807`).
- Canonical form is exactly seven fractional digits; `5`, `5.0` and
  `5.0000000` all canonicalize to `5.0000000`. Indexed payments are stored in
  canonical form and a non-canonical Horizon record is counted as malformed and
  never persisted.

## Large integer counters (`src/common/validation/safe-integer.ts`)

Ledger numbers, paging tokens and checkpoint/audit sequences can exceed
`Number.MAX_SAFE_INTEGER`. They travel as canonical decimal strings and are held
as `bigint`. Conversion to `number` is allowed only when lossless and otherwise
throws `UnsafeIntegerError`. Checkpoint `sequence` (request) is validated as a
canonical string within the int64 range and documented in OpenAPI as a
string-encoded integer. Offline bundle checkpoint `version` is a number only
while it is a safe integer; larger values are refused instead of rounded.

## Fee ceilings and surge policy (`src/config/fee-policy.ts`)

Contract submissions (`register_proof`, `revoke_proof`) pass `--fee` to the
Stellar CLI as decided by the policy. All values are stroops per transaction.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONTRACT_FEE_BASE_STROOPS` | 100 | Minimum paid; used with no or stale estimate |
| `CONTRACT_FEE_SURGE_THRESHOLD_STROOPS` | 1000 | Estimates above this are a surge |
| `CONTRACT_FEE_SURGE_MULTIPLIER` | 2 | Headroom applied to the estimate while surging |
| `CONTRACT_FEE_MAX_STROOPS` | 100000 | Hard ceiling; no fee ever exceeds it |
| `CONTRACT_FEE_REFUSAL_THRESHOLD_STROOPS` | 1000000 | At or above this, submission is refused |
| `CONTRACT_FEE_ESTIMATE_MAX_AGE_MS` | 60000 | Older estimates are stale |
| `CONTRACT_FEE_ESTIMATE_ENABLED` | true | Read Horizon `/fee_stats` (p90 charged fee) |

Safe reason codes logged per decision: `normal`, `surge`, `surge_capped`,
`ceiling_applied`, `estimate_unavailable`, `estimate_stale`,
`refused_over_threshold`. An invalid combination fails at startup. A refused
submission never touches the contract; the anchoring intent is held without
consuming an attempt.

## Sequence desynchronization recovery (`src/jobs/anchoring-worker.service.ts`)

A `tx_bad_seq` outcome starts bounded reconciliation (3 rounds), serialized per
process. Each round reads authoritative on-chain state first:

- already registered/revoked: the intent is confirmed and never resubmitted;
- state cannot be verified: no blind retry, normal transient backoff;
- not applied: one more submission (the CLI re-reads the account sequence);
- still desynchronized after the bound: the intent is `QUARANTINED` with reason
  `SEQUENCE_DIVERGENCE` (new enum value, migration
  `20261218000000_add_sequence_divergence_quarantine_reason`) and is visible
  through the existing anchoring status API and operator redrive/abandon flow.

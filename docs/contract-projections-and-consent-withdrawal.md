# Consent withdrawal and contract-state projections

This document covers four related API surfaces. Three are read-only projections
of indexed contract events; one is a subject-driven lifecycle.

| Surface | Route | Auth |
| --- | --- | --- |
| Consent withdrawal | `/proofs/disclosure-receipts/:receiptId/consent-withdrawal` and `/proofs/consent-withdrawals/:id` | Session bearer token, subject only |
| Pause acknowledgement status | `GET /health/protocol-pause/:contractId/acknowledgements` | Public, privacy-safe |
| Decommission grace policy | `GET /contracts/:network/:contractId/decommission` | API key, `ORG_READ` |
| Activation acknowledgement evidence | `GET /proofs/:id/activation-acknowledgements` | Session bearer token, owner or admin |

All list-like responses are bounded and every projection reports its own
freshness. None of the projections is a source of truth: the contract is.

## Consent withdrawal

A subject withdraws consent for one disclosure receipt.

1. `GET .../consent-withdrawal/eligibility` returns `eligible` and, when not,
   one of `RECEIPT_EXPIRED`, `WITHDRAWAL_IN_PROGRESS`, `WITHDRAWAL_FAILED`
   (retry through the reconcile endpoint), `ALREADY_WITHDRAWN`.
2. `POST .../consent-withdrawal` with an `Idempotency-Key` header (16-64 of
   `A-Z a-z 0-9 _ -`) returns `202` with the withdrawal. Replaying the same key
   and receipt returns the same withdrawal. Reusing the key for a different
   receipt returns `422`. A receipt that is expired, or already has a
   withdrawal, returns `409`.
3. `GET /proofs/consent-withdrawals/:id` returns status.
   `PENDING` becomes `CONFIRMED` on contract confirmation, or `FAILED` after
   a permanent contract rejection or 5 transient failures.
4. `POST /proofs/consent-withdrawals/:id/reconcile` retries a `PENDING` or
   `FAILED` submission. Attempts for one withdrawal are spaced by a 30 second
   cooldown that is claimed with a conditional update, so concurrent callers
   cannot double-submit. A manual retry of a `FAILED` withdrawal resets its
   attempt count.
5. `GET /proofs/consent-withdrawals/:id/receipt` returns the receipt once
   confirmed (`409` before that).

Guarantees:

- Another subject's receipt or withdrawal returns the same `404` as a missing
  one. Nothing is created or submitted before ownership is established.
- The request row and its `AuditLog` entry (`proof.consent_withdrawal_requested`)
  commit in one transaction. A failed audit write fails the request.
- Only hashes reach the contract: the SHA-256 of the receipt id and a
  commitment derived from the receipt id and subject id.
- A withdrawal records the subject's decision. It does not delete the receipt,
  the proof, or any anchored record, and the receipt says so
  (`recordsDeleted: false`).
- Outcomes that never reached the contract (anchoring disabled, circuit open,
  sequence busy, fee refused) do not consume an attempt.
- Stored failure codes are a fixed set; raw RPC or CLI output is never stored.

The contract call is `withdraw_disclosure_consent(receipt_id_hash,
withdrawal_commitment)`. It is invoked through the existing submission path
(sequence lease, simulation, fee policy and circuit breaker).

Background reconciliation is off by default. Set
`CONSENT_WITHDRAWAL_RECONCILIATION_ENABLED=true` to retry pending withdrawals
every minute, at most 25 per pass.

## Pause acknowledgement status

Projects acknowledgement events for an emergency pause: current sequence,
scopes, actor role counts, the incident commitment and consistency findings.

- Only a 64-character lowercase SHA-256 commitment to the incident is stored.
  Event fields outside the schema are dropped at ingestion, so incident content
  cannot reach the database or the response.
- `grantsUnpauseAuthority` is always `false`. An acknowledgement records that a
  role saw the pause; it is not an authorization.
- `limit` defaults to 20 and is capped at 100. Findings are computed over the
  returned window, so cost does not grow with history.
- Findings: `SEQUENCE_GAP`, `CONFLICTING_SEQUENCE`, `COMMITMENT_MISMATCH`
  (blocking) and `PAUSE_STATE_UNKNOWN`, `PAUSE_STATE_STALE` (advisory). Any
  blocking finding yields `INCONSISTENT`; advisory findings alone yield
  `UNVERIFIED`; none yields `CONSISTENT`. A pause-state projection older than
  five minutes is stale.

## Decommission grace policy

Returns grace boundaries, successor identity, terminal state and a decision for
each capability (`READ`, `VERIFY`, `REVOKE`, `ISSUE`, `ANCHOR`, `MIGRATE`).

Rules, evaluated at request time:

- `READ` and `VERIFY` are always allowed.
- An unknown contract, or state not refreshed in five minutes, denies every
  mutation.
- A grace window not yet started reads as `ACTIVE`.
- The grace end is exclusive: at the exact end instant the contract is
  `DECOMMISSIONED` and mutations fail with `GRACE_EXPIRED`. A grace row with
  no end fails closed the same way.
- During grace, a mutation is allowed only if the indexed state lists it.
- A terminal contract denies all mutations and cannot be reopened by a later
  event. Events from an older or equal ledger are ignored.
- A declared grace window must be positive and at most 365 days.

The decision is derived from stored state and the clock on each request, so it
needs no background job to take effect when a grace period ends.

## Activation acknowledgement evidence

Off-chain projection of the acknowledgements a delayed-activation proof needs.

- Responses carry `projection.state` (`FRESH`, `STALE` after 10 minutes, or
  `UNAVAILABLE`), the observed ledger and last reconciliation time.
- `allRequiredAcknowledged` is `null` unless the projection is fresh and at
  least one acknowledgement is required.
- `authoritative` is always `false` and `proofValidity` is always
  `NOT_DETERMINED`. The projection never writes to the proof and cannot mark
  one valid. Validity comes from verification.
- A completed acknowledgement is never downgraded by a late or replayed
  "required" event.
- Page size defaults to 25 and is capped at 50; `truncated` reports overflow.
- Unknown proofs and proofs owned by someone else return the same `404`.

## Event ingestion

The projections are filled by `PauseAcknowledgementService.ingest`,
`ContractDecommissionService.applyState` and `ProofActivationAckService.ingest`.
Pause and activation acknowledgements go through `applyProjectionEventOnce`,
which claims the event in `ContractEventApplied` in the same transaction as the
write, so live ingestion and gap backfill cannot apply an event twice.
Decommission state is a snapshot rather than an event log, so it is idempotent
by ledger instead: an event at or below the stored ledger is ignored. This change adds
the projections and their read APIs. It does not add a chain event subscriber;
that feeds these methods separately.

# Contract anchoring: preflight, sequence coordination and identity gate

This covers four production-readiness controls around Soroban anchoring. All
of them are inert until `SOROBAN_RPC_URL` is set (the sequence lease is the
exception: it applies whenever anchoring is enabled).

## Simulation before submission

Before a register or revoke call is signed, the service builds the unsigned
transaction (`stellar contract invoke --build-only`) and simulates it on the
Soroban RPC. The result is judged by `src/proofs/soroban/simulation-policy.ts`:

| Outcome | Reason code | Submitted | Retry |
| --- | --- | --- | --- |
| Contract/host error | `contract_rejected` | No | Never (quarantined) |
| Fee, CPU or memory above policy | `resource_limit_exceeded` | No | Never (quarantined) |
| Auth entry valid for too long | `auth_expiration_too_long` | No | Never (quarantined) |
| Archived entries need restoring | `restore_required` | No | Backoff |
| Auth entry expired / too short | `auth_expiration_expired`, `auth_expiration_too_short` | No | Backoff, fresh simulation |
| Malformed body, unbuildable transaction, RPC down | `malformed_simulation`, `simulation_unavailable` | No | Backoff |

The preflight fails closed: no verdict means no submission.

`ContractSimulationRecord` stores one row per simulation: numbers and reason
codes only. It holds no XDR, arguments or error text, and the proof id appears
only as a SHA-256. `correlationId` is written to the submission log line and,
after a successful submission, `submittedTransactionHash` is filled in, so a
simulation can be tied to the transaction that followed it.

## Authorization entry expiration

Each address-credential entry's `signatureExpirationLedger` is compared with
the simulation's `latestLedger`. `remaining = expiration - current`; the window
`[CONTRACT_AUTH_EXPIRATION_MIN_LEDGERS, CONTRACT_AUTH_EXPIRATION_MAX_LEDGERS]`
is inclusive at both ends, and `remaining < 0` is expired. Only ledger numbers
are used, never wall-clock time, so every worker reaches the same verdict. The
check runs before the signing call.

## Source-account sequence coordination

`SourceSequenceCoordinator` takes an exclusive, expiring lease per Stellar
source account (`SourceAccountSequenceLease`, keyed by a hash of the source).
Only the holder builds and submits, so each submission sees the sequence left
by the previous one.

- Acquisition is one unique-key insert or one conditional update, so exactly
  one concurrent caller wins.
- A lease that is not renewed expires after `CONTRACT_SEQUENCE_LEASE_TTL_MS`
  (default 150s, above the 120s CLI timeout) and the next caller takes it over,
  bumping `fencingCounter`.
- The holder renews immediately before submitting. If it was taken over, the
  renewal fails and nothing is submitted.
- A busy account returns `sequence_busy`; the worker releases the intent
  without consuming an attempt.
- `tx_bad_seq` is a sequence conflict, not a transport failure: it is retried
  after 5 seconds (still counting an attempt) and never trips the circuit
  breaker. Transport failures keep the exponential backoff and do trip it.

The CLI still chooses the sequence number; the lease guarantees that only one
worker per source account is doing so at a time. Expiry uses the application
clock, so keep clock skew well below the TTL (see [clock skew](clock-skew.md)).

## Startup identity gate

When anchoring is enabled and `SOROBAN_RPC_URL` is set, readiness requires a
verified `contract_identity` dependency:

- the RPC's network passphrase equals `STELLAR_NETWORK_PASSPHRASE`;
- each configured contract is deployed on that network;
- each contract's WASM hash is one pinned in
  `PROOF_REGISTRY_EXPECTED_WASM_HASHES` / `ISSUER_REGISTRY_EXPECTED_WASM_HASHES`
  (the pin is the deployment and interface identity; list several hashes for a
  rolling upgrade);
- the two registries are not swapped or configured with the same id.

Until the first check completes the service reports `contract_identity_pending`.
An unreachable RPC keeps it not ready (`rpc_unavailable`, `rpc_timeout`).
Checks are bounded by `CONTRACT_IDENTITY_TIMEOUT_MS`, retried every 10s while
failing and re-verified every 5 minutes once healthy. Only stable reason codes
are logged or returned; never ids, hashes, URLs or the passphrase.

If a pin variable is empty, the hash comparison is skipped for that contract
(deployment and network are still checked).

## Configuration

See [`.env.example`](../.env.example): `SOROBAN_RPC_URL`,
`SOROBAN_RPC_TIMEOUT_MS`, `CONTRACT_SIMULATION_*`,
`CONTRACT_AUTH_EXPIRATION_*_LEDGERS`, `CONTRACT_SEQUENCE_LEASE_TTL_MS`,
`CONTRACT_IDENTITY_*`, `*_EXPECTED_WASM_HASHES`.

# Contract Call Deadlines and Cancellation

A timeout that only rejects the caller's promise does not stop the work. The
Stellar CLI child or RPC call keeps running and may later "succeed" with nobody
waiting, which is how an intent can be marked confirmed after its worker or
request has already given up. Deadlines here are `AbortSignal`s handed to the
operation itself, so a timeout or cancellation kills the work and frees its
resources.

## Per-operation deadlines

| Operation | Variable | Default | Bounds |
|---|---|---|---|
| Register (anchor) | `CONTRACT_REGISTER_DEADLINE_MS` | `120000` | 1000 to 300000 |
| Revoke | `CONTRACT_REVOKE_DEADLINE_MS` | `120000` | 1000 to 300000 |
| Read (status) | `CONTRACT_READ_DEADLINE_MS` | `60000` | 1000 to 300000 |
| Whole reconciler run | `CONTRACT_RECONCILE_RUN_DEADLINE_MS` | `240000` | 5000 to 1800000 |
| Handler on `RequestTimeoutInterceptor` routes | `VERIFICATION_REQUEST_TIMEOUT_MS` | `5000` | 100 to 120000 |

Values are clamped into their bounds and a non-numeric value falls back to the
default, so a misconfiguration can neither disable a deadline nor make it
unbounded.

## Where the signal comes from

[`ContractAnchoringService`](../src/proofs/contract-anchoring.service.ts) combines
up to three signals for each call:

1. the per-operation deadline,
2. an explicit `options.signal` (the anchoring worker passes its shutdown signal,
   the reconciler its run deadline), and
3. the enclosing HTTP request's signal, picked up from the async context with no
   signature change.

The combined signal is passed to the CLI child, so abort kills the process.

## Result semantics

`AnchorProofResult` and `ContractProofStatus` gain two reasons:

- `timeout`: the deadline elapsed and the call was aborted.
- `cancelled`: the caller went away (shutdown, client disconnect).

If the CLI reports success in the instant before an abort is observed, the result
is **discarded** and reported as `cancelled`/`timeout`. A caller whose request
has gone is never told the operation succeeded.

| Caller | On `timeout` | On `cancelled` |
|---|---|---|
| Anchoring worker | counted as a transient failure and retried with backoff | intent released back to `PENDING` without consuming an attempt; never written `CONFIRMED` |
| Reconciler | the read is reported as unchecked; no repair | no repair; remaining proofs deferred when the run deadline elapses |
| `CONTRACT_ANCHORING_REQUIRED=true` | throws, so issuance fails closed | throws |

Error text for an abort is fixed (`<operation> exceeded its Nms deadline`, or
`<operation> was cancelled`). It never embeds CLI argv, which can include the
signing source.

## Circuit breaker

A deadline counts toward opening the circuit, because a dependency too slow to
answer is exactly what the breaker tracks. A caller cancellation does not: it
says nothing about the dependency.

## Worker shutdown

When the drain budget is exhausted the worker aborts the shared signal, which
kills in-flight CLI children and releases their intents instead of leaving them
`PROCESSING` until stale-recovery.

## Limitations

- An aborted `register` may have reached the chain before the child was killed.
  The retry then receives "already registered", which is classified as a
  permanent outcome, so that intent is quarantined for operator review rather
  than silently confirmed. This is the same outcome the previous bare
  `timeout` option produced; the change is that the abort now actually stops the
  child and a late success can no longer be recorded.
- Prisma cannot cancel a statement already sent to the database. The existing
  request-abort guard stops further statements after an abort; an in-flight
  statement still completes.

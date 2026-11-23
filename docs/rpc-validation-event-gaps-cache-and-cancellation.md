# RPC validation, event gaps, config cache, and request cancellation

This note describes four related hardening changes. Each is self-contained.

## Soroban RPC response validation

`src/common/validation/soroban-rpc.schemas.ts` defines runtime schemas for
transaction, simulation, event, digest, and error responses.
`parseSorobanRpcResponse(kind, payload)` must run before business logic reads a
response.

- A response that does not match fails closed with `SorobanRpcResponseError`.
  Stable codes: `SOROBAN_RPC_RESPONSE_MALFORMED`,
  `SOROBAN_RPC_RESPONSE_TOO_LARGE`, `SOROBAN_RPC_REPORTED_ERROR`.
- Unknown additive fields are accepted and dropped, so RPC upgrades do not
  break parsing.
- Responses are bounded: 2 MiB total, 256 KiB per field, 10,000 events.
- The error carries the response kind and schema paths only. A received value
  never appears in the message, so a raw RPC payload cannot reach a log.

Consumers: `ContractDigestClient` validates digests with this module, and
`ContractAnchoringService.getProofStatus` no longer reads a non-boolean CLI
answer as `false` (which would report a revoked proof as not revoked).

## Contract event gap detection and backfill

`ContractEventGapService` (`src/jobs/contract-event-gap.service.ts`) tracks which
ledgers of a contract event stream have been projected.

- Live ingestion calls `observeLiveRange(streamKey, from, to)`. A jump past the
  highest ledger seen is recorded as a `ContractEventGap` row with a range and a
  status (`DETECTED`, `BACKFILLING`, `RESOLVED`, `IRRECOVERABLE`). Late live
  delivery that overlaps a gap shrinks or resolves it.
- `runBackfill(source, handler)` claims gaps with a compare-and-set, reads at
  most `maxLedgersPerChunk` ledgers per chunk and `maxChunksPerRun` chunks per
  run, and shrinks the gap to what remains, so it is resumable. A claim older
  than `claimLeaseMs` is treated as abandoned.
- Both paths apply events through `applyEventOnce`. The `ContractEventApplied`
  primary key `(streamKey, eventId)` admits each event once, so live and backfill
  cannot double-apply.
- A range the provider no longer retains is marked `IRRECOVERABLE`
  (`PROVIDER_RETENTION`); a range that keeps failing becomes `IRRECOVERABLE`
  (`RETRIES_EXHAUSTED`). Provider error text is never stored.

Not included: a `ContractEventSource` adapter bound to the RPC and a scheduled
job. Binding the source (and validating its responses with the schemas above) is
the integration point.

## Protocol configuration cache

`ProtocolConfigCache` (`src/common/cache/protocol-config-cache.ts`) caches
schema, asset, and contract-policy configuration.

- Keys are `namespace:id` with protocol identifiers only, never tenant data.
- `applyGovernanceEvent` invalidates an entry or a whole namespace. Events are
  ordered by `(ledger, index)`; duplicates and reordered older events are ignored.
  A load that straddles an invalidation is not stored.
- TTL is the fallback for missed events.
- Reads declare `authorizationSensitive`. Such reads never get stale data and
  throw `ProtocolConfigUnavailableError` when a verified-fresh value cannot be
  loaded. Treat that error as a denial.
- `markFreshnessUnknown()` (for example after a detected event gap) makes
  entries loaded earlier untrusted until reloaded.
- `snapshotStats()` reports counts by namespace and outcome only.

## Request cancellation

When a client disconnects, `RequestAbortInterceptor` aborts a request-scoped
signal held in `AsyncLocalStorage` (`src/common/request-context/request-abort.ts`).

- `PrismaService.$transaction` is guarded: no transaction starts for an aborted
  request, no statement is issued after the abort inside an interactive
  transaction, and a transaction aborted before commit rolls back. The outcome is
  a clean rollback or a completed commit.
- The driver cannot cancel a statement already in flight. That statement
  finishes; no further work is issued. Batch (array) transactions are checked
  only before they start.
- `listPayments` and `listProofs` check the signal before querying. Other code
  can call `throwIfRequestAborted()`.
- Cancellation maps to `499 REQUEST_ABORTED`, is logged at debug level, and is
  not an internal error. Jobs and scripts run without a signal and are unchanged.
- A mutation aborted after its statements ran but before commit is rolled back,
  so the client may need to retry (use an idempotency key where available).

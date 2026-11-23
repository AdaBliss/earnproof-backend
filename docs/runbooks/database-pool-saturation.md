# Runbook: Database connection-pool saturation

## What fired

| Alert | Condition | Severity | Owner |
|---|---|---|---|
| Pool saturation sustained | `database_pool` readiness dependency `error` with reason `database_pool_saturation_sustained` | **P1** | Platform on-call |
| Pool saturation warning | Pool utilization ≥ 70% or wait p95 ≥ 100 ms on a single sample | **P2** | Platform on-call |
| Pool wait latency | p95 `database_pool_wait_duration_ms` > 500 ms over 10 min | **P2** | Platform on-call |
| Pool timeouts | `database_pool_timeouts_total` increasing | **P2** | Platform on-call |

The monitor reads the Prisma client's own pool metrics (open / busy / idle
connections, queries waiting for a connection, and the wait histogram) and
exposes a bounded snapshot at `GET /metrics/database/pool` (ADMIN role) and
in the authorized `GET /health/diagnostics` response under the
`database_pool` dependency. Thresholds, hysteresis state, and this runbook
link are part of the snapshot.

**Why hysteresis.** One saturated sample is a spike: a burst of requests, a
slow query finishing, a deploy. Readiness only fails after 3 consecutive
saturated samples (`DB_POOL_SUSTAIN_SAMPLES`, default 3), and only clears
after 2 consecutive healthy samples (`DB_POOL_CLEAR_SAMPLES`, default 2).
A single sample can warn, but it cannot drain a replica from the load
balancer.

**Why these thresholds.** Warn at 70% utilization / 100 ms wait p95,
critical at 90% / 500 ms. At 90% a small burst exhausts the pool; at 500 ms
wait, requests are queueing longer than most API handlers should take.
Defaults are overridable with `DB_POOL_WARN_UTILIZATION`,
`DB_POOL_CRITICAL_UTILIZATION`, `DB_POOL_WARN_WAIT_MS`,
`DB_POOL_CRITICAL_WAIT_MS` (warn must stay below critical; startup
validation enforces it).

## Diagnose

### 1. What does the snapshot say?

```json
GET /metrics/database/pool
```

- **`pool.utilization` near 1** → the pool is genuinely full. Steps 2–4.
- **`pool.waiting` > 0 with low utilization** → queries are queueing
  behind a few long-running ones, not behind pool size. Step 3.
- **`wait.p95Ms` high, utilization low** → same: a slow query or lock,
  not pool size.
- **`status: "unknown"`** → pool metrics are unavailable. The database may
  be down — check `GET /health/ready` first; a dead database already fails
  readiness and this runbook does not apply. See
  [database-health.md](database-health.md).
- **`timeouts.total` climbing** → acquisitions are timing out
  (`pool_timeout`, default 10 s). Treat as saturation: step 2.

### 2. Is the pool sized for the load?

The effective limit is `pool.limit` in the snapshot: the `connection_limit`
query parameter of `DATABASE_URL`, or Prisma's default of `2 * CPUs + 1`
when unset. Compare it with the instance's `max_connections` and with the
number of replicas: `replicas * connection_limit` must stay below what the
instance allows, or replicas starve each other.

### 3. What is holding connections?

- **A long-running query** — inspect active queries on the instance. A
  single unindexed query can hold a connection for seconds while every
  other request queues behind it.
- **A traffic spike** — visible in `http_requests_total`. Saturation that
  tracks traffic is a sizing problem, not a leak.
- **A job burst** — check `job_runs_total`. Bounded batches still compete
  for connections while they run.
- **A leak** — utilization that climbs monotonically and never falls after
  traffic subsides points at connections not being returned (for example a
  transaction left open). Check for long-lived idle-in-transaction sessions
  on the instance.

### 4. Did something deploy?

A new unindexed query, a new job, or a higher replica count all present as
sudden saturation. Check the deploy log before changing pool settings.

> Connection strings are redacted in logs and never appear in health
> output by design. Read configuration from the deployment environment,
> not from a log line, and never paste a DSN into a ticket. The snapshot
> carries counts, ratios, and latencies only — no host, credential, or
> query text.

## Mitigate

| Cause | Action |
|---|---|
| Pool too small for traffic | Raise `connection_limit` (and the instance `max_connections` if needed), or add replicas only if the instance has headroom. |
| Long-running query | Identify and terminate it. Fix the query afterwards. |
| Traffic spike | Shed load at the edge if possible; saturation clears on its own when traffic falls. |
| Job contention | Reduce batch size or move the schedule to a quieter window. |
| Connection leak | Restart the affected replica to reclaim connections, then fix the leak — a restart without a fix only resets the clock. |
| Too many replicas | Reduce replica count, or lower per-replica `connection_limit` so the total stays under the instance limit. |

## Verify

- `pool.utilization` back under 70% and `wait.p95Ms` under 100 ms for at
  least 5 minutes.
- `timeouts.total` stops increasing.
- `GET /health/ready` returns 200 (the sustained-critical latch clears
  after 2 consecutive healthy samples).
- API 5xx rate recovered — if it has not, there is a second cause.

## Escalate

- Utilization stays above 90% after mitigation, or timeouts keep climbing.
- The instance itself is out of connections (`max_connections` reached) —
  that is a capacity decision, not a tuning change.
- Data corruption or loss is suspected — stop and escalate before taking
  any further action that could compound it.

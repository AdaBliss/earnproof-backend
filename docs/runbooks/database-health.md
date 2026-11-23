# Runbook: Database health

## What fired

| Alert | Condition | Severity | Owner |
|---|---|---|---|
| Database probe failure | `database_probes_total{health="down"}` in 2 consecutive probes | **P1** | Platform on-call |
| Database probe latency | p95 `database_probe_duration_ms` > 200 ms over 10 min | **P2** | Platform on-call |

The probe is the `SELECT 1` behind `GET /health`. If it fails, essentially every
endpoint fails with it — this is the most upstream alert in the catalog, and
other alerts firing at the same time are usually its symptoms.

**Why two consecutive.** One failed probe is a blip. Two in a row is a pattern,
and waiting for a third would delay a P1 response for no diagnostic gain.

**Why 200 ms.** Four times the 50 ms objective. A trivial query taking that long
signals pool exhaustion or resource pressure well before it becomes an outage.

## Diagnose

### 1. Down, or just slow?

```
database_probes_total{health="down"}
histogram_quantile(0.95, database_probe_duration_ms)
```

- **Down** → connectivity or the database process. Steps 2–3.
- **Slow but up** → contention or pool pressure. Step 4.

Pool saturation has its own monitor and runbook:
[database-pool-saturation.md](database-pool-saturation.md). The bounded
pool snapshot (occupancy, wait latency, timeout counts, thresholds) is at
`GET /metrics/database/pool` (ADMIN) and in authorized
`GET /health/diagnostics` under `database_pool`. Readiness fails only on
sustained saturation — 3 consecutive saturated samples — not on a spike.

### 2. Is the database reachable?

Check the instance directly: is the process running, accepting connections, and
reachable from the application's network?

Connection errors surface as `PrismaClientInitializationError` and map to
`DEPENDENCY_UNAVAILABLE` in the API. Look for that class name in logs.

### 3. Connections or credentials?

- **Connection refused** → the database is down or unreachable.
- **Authentication failed** → credentials changed or rotated.
- **Too many connections** → the server-side limit is exhausted, often by
  another client sharing the instance.

> Connection strings are redacted in logs by design. Read configuration from the
> deployment environment, not from a log line, and never paste a DSN into a
> ticket.

### 4. What is causing the pressure?

If the probe is slow, the trivial query is queueing behind something. Check:

- **Application concurrency** — a traffic spike, visible in `http_requests_total`.
- **A long-running query** — inspect active queries on the instance.
- **Retention cleanup** — check `job_runs_total{job="retention_cleanup"}`. Batches
  are bounded, but a large batch on a big table still competes for I/O.
- **Storage or CPU saturation** — check instance metrics.
- **Lock contention** — a migration or long transaction blocking readers.

### 5. Did something deploy?

A new unindexed query, or a migration on a large table, both present as sudden
probe latency.

## Mitigate

| Cause | Action |
|---|---|
| Database process down | Restart or fail over. This is the whole incident. |
| Connection limit reached | Reduce application pool size, or raise the server limit if resources allow. |
| Credentials rotated | Update configuration and redeploy. |
| Long-running query | Identify and terminate it. Fix the query afterwards. |
| Cleanup job contention | Reduce batch size or move the schedule to a quieter window. |
| Resource saturation | Scale the instance. Reduce load in the meantime. |
| Migration holding locks | Wait if it will finish; otherwise abort and reschedule for a maintenance window. |

## Verify

- Probes succeeding consistently for at least 5 minutes.
- Probe p95 back under 50 ms.
- API 5xx rate recovered — if it has not, there is a second cause.
- Background jobs resumed, and any backlog they accumulated is draining.

## Escalate

- The database is down and does not come back within 10 minutes.
- Failover is required.
- Data corruption or loss is suspected — stop and escalate before taking any
  further action that could compound it.
- The fix needs a schema change or capacity increase requiring approval.

# Observability

The signal catalog for EarnProof API: what the service measures, what an
operator is expected to alert on, and the privacy rules every signal obeys.

Operational logs already existed across auth, Horizon sync, anchoring,
credentials, and webhooks. What was missing was a consistent vocabulary and a
response procedure. This document supplies both; the conventions it describes are
enforced in code, not by convention alone.

- Runbooks: [`docs/runbooks/`](runbooks/)
- Label vocabulary: [`src/common/observability/metric-labels.ts`](../src/common/observability/metric-labels.ts)
- SLI catalog: [`src/common/observability/metrics.catalog.ts`](../src/common/observability/metrics.catalog.ts)

## Operational telemetry is not product analytics

These are different systems with different rules, and conflating them is how
private data ends up in a dashboard that half the company can read.

| | Operational telemetry | Product analytics |
|---|---|---|
| **Question** | Is the service healthy right now? | How are people using the product? |
| **Audience** | On-call engineers | Product and business |
| **Granularity** | Aggregate only | Often per-user by design |
| **Retention** | Short — days to weeks | Long — months to years |
| **Subject data** | **Never** | With a lawful basis and consent |
| **Lives in** | This document, `src/common/observability/` | Not in this repository |

Everything described here is operational. **No signal in this catalog may carry
a wallet address, proof identifier, amount, memo, URL, signature, or raw error
text** — not as a metric label, not as a log field, not in an alert payload.

If a question needs per-subject data to answer, it is a product-analytics
question and does not belong in this system. The practical test: if you cannot
write down the complete set of values a dimension can take, it does not go in a
metric.

## Signal types

Three signals, three distinct jobs. Keeping them separate is what makes the
privacy rules enforceable.

**Metrics** are aggregate time series with bounded labels. They answer "how many"
and "how fast" and are what alerts fire on. They carry no identifiers of any
kind, including non-sensitive ones like a request ID — an unbounded label makes
the metric unusable regardless of whether it leaks anything.

**Logs** are per-event records. They carry a correlation identifier so an
operator can pivot from an aggregate to a specific occurrence. Message text is
redacted before it is written.

**The database** is where subject data lives. An operator holding a correlation
ID from a log line looks the record up directly, under normal access controls
and audit. That lookup is deliberately a separate, authorised step.

The pivot path is: *alert fires on a metric* → *find affected runs in logs by
workflow and time* → *take the correlation ID* → *query the database if the
incident genuinely requires record detail*.

## Service level indicators

Each SLI names the metric that measures it, its objective, and the runbook for
its alert.

### API availability

| | |
|---|---|
| **Metric** | `http_requests_total{route,method,status_class}` |
| **SLI** | `1 - (5xx / total)`, over a 5-minute window |
| **Objective** | 99.5% of requests non-5xx over 28 days |
| **Runbook** | [api-availability.md](runbooks/api-availability.md) |

`status_class` is a family (`2xx`…`5xx`), not a status code. Alerting on
individual codes produces noise: a spike in 404s is usually a client walking
paths, while a spike in 5xx is always the service's problem.

### API latency

| | |
|---|---|
| **Metric** | `http_request_duration_ms{route,method}` |
| **SLI** | p95 and p99 per route template |
| **Objective** | p95 < 500 ms, p99 < 2000 ms over 28 days |
| **Runbook** | [api-latency.md](runbooks/api-latency.md) |

Failures are included in the histogram. A latency metric that silently excludes
errors measures the wrong population — during an incident, the failing requests
are the interesting ones.

### Request representation and expansion rejections

| | |
|---|---|
| **Metric** | `request_body_rejections_total{rejection}` |
| **Purpose** | Count ambiguous/unsupported media types and charsets, plus compressed-size, expanded-size, and expansion-ratio rejections |
| **Labels** | Closed reason vocabulary only; no route, request, or payload data |

### Horizon sync freshness

| | |
|---|---|
| **Metrics** | `horizon_sync_lag_seconds{workflow}`, `horizon_sync_runs_total{outcome}`, `horizon_sync_duration_ms{outcome}` |
| **SLI** | Seconds between the newest synced ledger and now |
| **Objective** | Lag p95 < 60 s; no successful sync gap exceeding 15 minutes |
| **Runbook** | [horizon-sync-lag.md](runbooks/horizon-sync-lag.md) |

Freshness needs its own gauge. A run counter alone cannot distinguish "syncing
happily" from "syncing every minute and falling further behind each time".

### Anchoring backlog

| | |
|---|---|
| **Metrics** | `anchoring_backlog_size{workflow}`, `anchoring_intents_total{job_result}`, `anchoring_attempt_duration_ms{outcome}` |
| **SLI** | Pending intents at poll start; permanent-failure rate |
| **Objective** | Backlog p95 < 50; permanent failures < 1% of terminal intents |
| **Runbook** | [anchoring-backlog.md](runbooks/anchoring-backlog.md) |

`job_result` separates `retried` from `failed_permanent`. They demand different
responses: retries are the system working as designed, permanent failures are
proofs that will never anchor without intervention.

### Webhook delivery

| | |
|---|---|
| **Metrics** | `webhook_deliveries_total{outcome,status_class}`, `webhook_delivery_duration_ms{outcome}` |
| **SLI** | Successful deliveries / attempted deliveries |
| **Objective** | 99% delivered within 3 attempts over 28 days |
| **Runbook** | [webhook-delivery.md](runbooks/webhook-delivery.md) |

Deliberately **not** labelled by webhook URL or organisation. Either would make
series count grow with tenant count, and the URL is customer-controlled data.
When one tenant is failing, the logs answer which — the metric only says that
something is.

### Database health

| | |
|---|---|
| **Metrics** | `database_probes_total{dependency,health}`, `database_probe_duration_ms{dependency}` |
| **SLI** | Probe success rate and probe latency |
| **Objective** | 99.9% probe success; p95 probe < 50 ms |
| **Runbook** | [database-health.md](runbooks/database-health.md) |

### Database pool saturation

| | |
|---|---|
| **Metrics** | `database_pool_timeouts_total{outcome}`, `database_pool_wait_duration_ms{pool_status}` |
| **SLI** | Pool utilization and connection wait latency |
| **Objective** | Utilization < 70%; p95 wait < 100 ms; zero acquisition timeouts |
| **Runbook** | [database-pool-saturation.md](runbooks/database-pool-saturation.md) |

### Verification outcomes

| | |
|---|---|
| **Metric** | `verifications_total{verification_outcome}` |
| **SLI** | Distribution across valid/invalid/expired/revoked/not_found |
| **Objective** | No alert on absolute rate; alert on a sudden distribution shift |
| **Runbook** | [verification-outcomes.md](runbooks/verification-outcomes.md) |

This is the subtlest signal in the catalog. A rise in `invalid` may be an attack,
a client bug, or a deployment regression — and *none* of those is a service
outage. It is a **ticket-severity** signal, not a page, and it is the one place
where an operator is most tempted to reach for per-proof detail. The outcome enum
is closed and carries no proof identity; which specific proof failed is a log
question.

### Background jobs

| | |
|---|---|
| **Metrics** | `job_runs_total{job,outcome}`, `job_duration_ms{job,outcome}`, `job_records_affected_total{job,workflow}` |
| **SLI** | Job success rate and execution duration |
| **Objective** | 99% of scheduled runs succeed; no job silent for more than two intervals |
| **Runbook** | [job-failures.md](runbooks/job-failures.md) |

`job_records_affected_total` is a **count only**. What was deleted or processed
is never a metric dimension and never appears in the accompanying log line.

## Bounded dimensions

Every permitted label and its complete value set is declared in
[`metric-labels.ts`](../src/common/observability/metric-labels.ts). The list
there is the authority; this section explains the rules it encodes.

**Default deny.** A label absent from the allowlist is rejected. Adding one
requires writing down its finite value set, which is a deliberate act reviewers
can see in a diff.

**Values are checked too.** Permitting the name `route` is not enough — the value
must be a declared route template. `/proofs/clx8y2…` is rejected even though
`route` is a permitted name, which is what stops a concrete path from creating a
series per proof.

**Enforced at registration and at observation.** A metric declaring a forbidden
label fails at application boot, so the test suite catches it rather than
production. A forbidden value fails at the call site.

**Violations throw.** A dropped label produces a metric that looks right on a
dashboard while measuring something other than its name claims. Failing loudly
is the lesser harm.

**Series budgets.** A metric whose theoretical series count exceeds 512 is
refused at registration. A live ceiling of 1,000 series per metric acts as a
backstop in case an unbounded value ever slips through.

### Forbidden as labels

Identifiers (wallet, proof, credential, session, API key, transaction),
financial values (amount, balance), free-form content (memo, message,
description), network and cryptographic material (URL, host, IP, user agent,
signature, secret, nonce), and raw error surfaces (error message, exception,
stack).

Also forbidden despite being privacy-safe: request ID, correlation ID, trace ID.
These are unbounded. They belong in logs.

## Correlation without high cardinality

`X-Request-ID` is accepted from the client or generated per request by
[`RequestIdInterceptor`](../src/common/interceptors/request-id.interceptor.ts),
echoed in the response header, and included in every error envelope.

It appears **only in log fields**, never as a metric label. Background jobs use
the same pattern with a `jobRunId` identifying one execution.

```
metric  http_requests_total{route="/proofs",method="POST",status_class="5xx"}
log     [8f14e45f…] anchoring attempt failed [requestId=8f14e45f… workflow=anchoring outcome=server_error durationMs=1240]
```

The alert fires on the metric; the log lines are found by workflow and time
window; the correlation ID reaches the specific record. No identifier ever
becomes a time series.

`OperationalLogger` rejects a forbidden log field rather than dropping it, for
the same reason the metric registry throws.

## Redaction

[`redaction.ts`](../src/common/observability/redaction.ts) redacts by *pattern*,
not by field name, because leaks arrive inside strings that were never structured
fields — a Horizon or Prisma error message carrying an address, a memo, or a
connection string with credentials.

Redacted: Stellar secret seeds, public keys, muxed accounts, contract IDs, JWTs,
`KEY=VALUE` environment leakage, URLs, hex digests of 32 bytes or more, long
base64 runs, and monetary amounts.

Two design decisions are worth stating:

**Order matters.** A secret seed and a public key are both 56-character base32
strings distinguished only by their first character. The secret rule runs first,
so a leaked seed is never masked under a label that understates its severity.

**Over-redaction has a cost.** Blanket amount-masking would eat the counts and
durations an operator needs, and a line reading `attempt [REDACTED] of
[REDACTED]` is useless during an incident. Numbers governed by a counting word
(`attempt`, `retry`, `count`, `records`, `ms`) survive; numbers with a decimal
part or an asset code do not.

`redactError` keeps the exception class name and a redacted message but **never
the stack** — stacks carry file paths and, in some frames, argument values. The
class name plus the correlation ID is enough to find the run and inspect it.

## Alert thresholds

Every alert carries a rationale, a severity, an owner, and a runbook. An alert
without all four gets ignored at 3am.

Severity is defined by required response, not by how alarming it sounds:

- **P1 — page immediately.** Users cannot use the product now.
- **P2 — page during business hours.** Degraded, or will become P1 if untreated.
- **P3 — ticket.** Needs investigation, not interruption.

| Alert | Condition | Severity | Owner | Rationale | Runbook |
|---|---|---|---|---|---|
| API 5xx rate | > 1% over 5 min | P1 | API on-call | Direct user impact; 1% is well above baseline but below the level where a single bad client dominates | [api-availability.md](runbooks/api-availability.md) |
| API 5xx spike | > 10% over 2 min | P1 | API on-call | Fast window catches a bad deploy before the slower alert would | [api-availability.md](runbooks/api-availability.md) |
| API latency | p95 > 500 ms over 10 min | P2 | API on-call | Degradation, not outage. Ten minutes avoids paging on a transient GC pause | [api-latency.md](runbooks/api-latency.md) |
| API latency severe | p99 > 5 s over 5 min | P1 | API on-call | At this level clients are timing out; functionally an outage | [api-latency.md](runbooks/api-latency.md) |
| Sync lag | p95 > 300 s over 15 min | P2 | Platform on-call | Proofs reflect stale payment data. Tolerable briefly, not for long | [horizon-sync-lag.md](runbooks/horizon-sync-lag.md) |
| Sync stalled | No successful sync in 15 min | P1 | Platform on-call | Distinguishes "slow" from "stopped". Stopped is unbounded staleness | [horizon-sync-lag.md](runbooks/horizon-sync-lag.md) |
| Anchoring backlog | > 100 pending for 15 min | P2 | Platform on-call | Above the worker's drain rate; the backlog will grow without intervention | [anchoring-backlog.md](runbooks/anchoring-backlog.md) |
| Anchoring permanent failures | > 1% of terminal intents over 1 h | P2 | Platform on-call | These never retry. Each is a proof that will not anchor without a human | [anchoring-backlog.md](runbooks/anchoring-backlog.md) |
| Webhook failure rate | > 5% over 15 min | P2 | Integrations on-call | Above 5% the cause is usually ours, not one bad endpoint | [webhook-delivery.md](runbooks/webhook-delivery.md) |
| Database probe failure | Any failure in 2 consecutive probes | P1 | Platform on-call | Two consecutive rules out a single transient blip | [database-health.md](runbooks/database-health.md) |
| Database probe latency | p95 > 200 ms over 10 min | P2 | Platform on-call | Four times the objective; usually connection-pool pressure before it becomes an outage | [database-health.md](runbooks/database-health.md) |
| Pool saturation sustained | 3 consecutive saturated samples (utilization ≥ 90% or wait p95 ≥ 500 ms) | P1 | Platform on-call | Sustained saturation means requests are about to fail acquiring connections; hysteresis rules out a single spike | [database-pool-saturation.md](runbooks/database-pool-saturation.md) |
| Pool wait latency | p95 > 500 ms over 10 min | P2 | Platform on-call | Requests queueing longer than handlers should take; usually a slow query or an undersized pool | [database-pool-saturation.md](runbooks/database-pool-saturation.md) |
| Pool timeouts | Any increase in `database_pool_timeouts_total` | P2 | Platform on-call | Acquisitions are timing out; saturation is already dropping work | [database-pool-saturation.md](runbooks/database-pool-saturation.md) |
| Verification shift | `invalid` share doubles week-on-week | P3 | Product engineering | Could be an attack, a client bug, or a regression. None is an outage; none warrants a page | [verification-outcomes.md](runbooks/verification-outcomes.md) |
| Job failure | Any job's success rate < 95% over 1 h | P2 | Platform on-call | Sustained failure means work is silently not happening | [job-failures.md](runbooks/job-failures.md) |
| Job silent | No run recorded in two intervals | P2 | Platform on-call | A job that stopped scheduling emits no failures — absence is the only signal | [job-failures.md](runbooks/job-failures.md) |

Alert payloads follow the same privacy rules as everything else: metric name,
label values from the bounded vocabulary, threshold, observed value, and a
runbook link. Never a sample record, never an error message.

## Instrumenting new code

```ts
// 1. Declare the metric in metrics.catalog.ts. Labels must be in the vocabulary.
registry.registerCounter({
  name: "example_total",
  help: "What this measures.",
  labelNames: ["workflow", "outcome"],
});

// 2. Record with bounded labels only.
metrics.increment(METRIC_NAMES.exampleTotal, {
  workflow: "credentials",
  outcome: "success",
});

// 3. Correlate in logs, never in metrics.
logger.error("credential issuance failed", error, {
  requestId,
  workflow: "credentials",
  outcome: "server_error",
});
```

If a label you want is not in the vocabulary, that is the design working. Either
it is genuinely bounded and privacy-safe — add it with its complete value set —
or it belongs in a log field.

## Test coverage

| Area | Suite | What it proves |
|---|---|---|
| Label vocabulary | [`metric-labels.spec.ts`](../src/common/observability/metric-labels.spec.ts) | Forbidden and unbounded labels are refused; route mapping cannot be inflated by any input |
| Redaction | [`redaction.spec.ts`](../src/common/observability/redaction.spec.ts) | Every sensitive shape is removed; counts and durations survive; stacks are never emitted |
| Registry | [`metrics.registry.spec.ts`](../src/common/observability/metrics.registry.spec.ts) | Bad definitions fail at registration; the SLI catalog registers cleanly and stays in budget |
| HTTP instrumentation | [`http-metrics.interceptor.spec.ts`](../src/common/interceptors/http-metrics.interceptor.spec.ts) | Failures are counted, not dropped; per-resource paths collapse to one series |

```bash
npm run lint
npm run test -- --runInBand
npm run build
```

## Maintenance

- Adding an SLI: declare it in `metrics.catalog.ts`, add a row above, write the runbook, add the alert with its rationale, severity, and owner.
- Adding a label: add it to `ALLOWED_METRIC_LABELS` with its complete value set. If you cannot enumerate the values, it belongs in a log field.
- Changing a threshold: update the rationale alongside the number. A threshold whose reasoning is not written down cannot be evaluated later.
- Adding a redaction rule: add it to `RULES` in the correct order — most specific first — and add a test with a realistic fixture.

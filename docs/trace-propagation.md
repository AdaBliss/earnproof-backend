# Trace Context Propagation

Request IDs correlate logs inside one process. They do not link a request to the
background anchoring it enqueued or to the webhook delivered because of it. This
service propagates [W3C Trace Context](https://www.w3.org/TR/trace-context/)
(`traceparent` / `tracestate`) across those boundaries, so one trace follows a
request through the durable queues, the contract call and the outbound webhook.

The implementation is in
[`trace-context.ts`](../src/common/observability/trace-context.ts). It has no
dependency on an OpenTelemetry SDK: it owns parsing, validation and the ambient
context, and hands finished spans to an exporter a deployment can install with
`setSpanExporter`. Context propagation works whether or not an exporter is
installed.

## Flow

| Boundary | How context crosses it |
|---|---|
| Inbound HTTP | [`TraceContextMiddleware`](../src/common/observability/trace-context.middleware.ts) parses `traceparent`; the server span becomes a child of the caller. No or invalid header starts a new trace. |
| Anchoring queue | The enqueuing request's context is stored on `AnchoringIntent.traceparent` / `tracestate`. The worker opens `anchoring.execute` as a child of it. |
| Contract call | `contract.invoke` is a child of the worker (or request) span. |
| Outbox | `DomainEventOutbox.traceparent` is captured on publish; the consumer runs as a child (`outbox.consume`). |
| Outbound webhook | `WebhookDelivery.traceparent` is stored; the attempt is a child span and sends `traceparent` (and `tracestate`) to the integrator. A retry row inherits the original context, so every attempt of one event shares a trace. |

The columns are nullable and additive (see the `add_trace_context_columns`
migration). A row without a context, such as one written before this change,
starts a fresh trace when processed.

## Untrusted input

Inbound trace fields come from the network, and persisted ones from a row, so
both are validated every time they are read:

- `traceparent` must match the W3C format exactly: lowercase hex, 32-character
  trace id and 16-character span id, neither all zero, version not `ff`, exactly
  55 characters for version `00`. Whitespace, uppercase, oversized values,
  repeated headers and header-injection attempts are rejected.
- `tracestate` must be a valid list (at most 32 members and 512 characters,
  valid keys and values, no duplicates). An invalid list is dropped whole; the
  trace itself is kept.
- Anything invalid is discarded and a **new** trace is started. A value is never
  repaired, echoed in a response, or logged, so a caller cannot choose a trace id
  by sending a malformed header, and a corrupt row cannot break processing.

## Span attributes

Attributes pass through an allowlist
([`ALLOWED_SPAN_ATTRIBUTES`](../src/common/observability/trace-context.ts)): HTTP
method, route **template**, status class, job name and operation, attempt number,
contract operation class, webhook event type and an outcome. Anything else is
dropped, and so is a value shaped like an identifier even under an allowed key:
Stellar account, secret seed or contract id, email address, URL, 64-hex hash,
record id or UUID.

So proof, user, organization, wallet and webhook identifiers, webhook
destination URLs, contract ids, signing sources and request or response bodies
never become span attributes. The `http.server` span records the route template
(`/proofs/:id`), never the concrete URL.

## Signatures

The trace headers are not part of the signed webhook material. The signature
still covers the timestamp, event id and body exactly as before.

## Adding an exporter

```ts
setSpanExporter({ export: (span) => bridgeToOpenTelemetry(span) });
```

Exporter failures are swallowed: telemetry never fails the operation it
describes.

## Limitations

- No exporter is bundled. Spans are produced and handed to the installed
  exporter; wiring an OTLP collector is a deployment decision.
- A webhook delivery created by an operator replay or dead-letter redrive takes
  the trace active at that moment (the operator request), not the original
  event's trace.
- Propagation is for the paths listed above. Other background jobs start their
  own traces unless they restore a carrier themselves.

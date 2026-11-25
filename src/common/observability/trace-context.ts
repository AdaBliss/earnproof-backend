import { AsyncLocalStorage } from "async_hooks";
import { randomBytes } from "crypto";

/**
 * W3C Trace Context (https://www.w3.org/TR/trace-context/) propagation.
 *
 * `traceparent` is the standards-based wire format every OpenTelemetry SDK and
 * collector understands, so a trace started by an upstream caller continues
 * through this service, its durable queues, contract calls and outbound
 * webhooks, and an OTel exporter can later be attached without changing any
 * call site. This module has no runtime dependency on an SDK: it owns the
 * parsing, validation and ambient context, and hands finished spans to an
 * exporter the deployment may install (see {@link setSpanExporter}).
 *
 * Inbound trace fields are untrusted. They arrive from the network (or from a
 * database row an earlier request wrote), so they are validated strictly and
 * anything malformed is discarded in favour of a fresh trace rather than
 * repaired.
 */

export interface TraceContext {
  /** 32 lowercase hex characters, never all zero. */
  traceId: string;
  /** 16 lowercase hex characters, never all zero. This span's id. */
  spanId: string;
  /** The span that caused this one, when known. */
  parentSpanId?: string;
  /** Trace flags byte as two lowercase hex characters. Bit 0 is "sampled". */
  flags: string;
  /** Validated W3C tracestate, or undefined. Propagated verbatim, never read. */
  tracestate?: string;
}

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const FLAGS = /^[0-9a-f]{2}$/;
const VERSION = /^[0-9a-f]{2}$/;

const ALL_ZERO_TRACE = "0".repeat(32);
const ALL_ZERO_SPAN = "0".repeat(16);

/** Length of a version-00 traceparent: 2 + 1 + 32 + 1 + 16 + 1 + 2. */
export const TRACEPARENT_LENGTH = 55;
/** tracestate is limited by the spec to 32 list members and, practically, 512 chars. */
export const TRACESTATE_MAX_LENGTH = 512;
export const TRACESTATE_MAX_MEMBERS = 32;

export const TRACEPARENT_HEADER = "traceparent";
export const TRACESTATE_HEADER = "tracestate";

// key = simple-key | tenant "@" system ; value = printable ASCII without , and =
const TRACESTATE_KEY = /^(?:[a-z][a-z0-9_\-*/]{0,255}|[a-z0-9][a-z0-9_\-*/]{0,240}@[a-z][a-z0-9_\-*/]{0,13})$/;
const TRACESTATE_VALUE = /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/;

function randomHex(bytes: number, zero: string): string {
  // The all-zero id is invalid; the probability is negligible but the spec is
  // explicit, so never emit it.
  for (;;) {
    const value = randomBytes(bytes).toString("hex");
    if (value !== zero) return value;
  }
}

/** Starts a new trace (a root span). */
export function newTraceContext(sampled = true): TraceContext {
  return {
    traceId: randomHex(16, ALL_ZERO_TRACE),
    spanId: randomHex(8, ALL_ZERO_SPAN),
    flags: sampled ? "01" : "00",
  };
}

/** A child span in the same trace: same trace id, new span id, parent = `parent`. */
export function childContext(parent: TraceContext): TraceContext {
  return {
    traceId: parent.traceId,
    spanId: randomHex(8, ALL_ZERO_SPAN),
    parentSpanId: parent.spanId,
    flags: parent.flags,
    tracestate: parent.tracestate,
  };
}

/**
 * Strictly parses a `traceparent` header value.
 *
 * Returns `null` for anything that is not a valid traceparent: wrong length or
 * shape, uppercase hex, the forbidden `ff` version, an all-zero trace or span
 * id, or surplus fields on a version-00 value. The returned context carries the
 * REMOTE span id as `spanId`; callers wanting a local span take
 * {@link childContext} of it.
 */
export function parseTraceparent(
  value: unknown,
  tracestate?: unknown,
): TraceContext | null {
  if (typeof value !== "string") return null;
  // No trimming or case folding: a value that needs normalising is malformed.
  if (value.length < TRACEPARENT_LENGTH || value.length > 512) return null;

  const parts = value.split("-");
  if (parts.length < 4) return null;
  const [version, traceId, spanId, flags] = parts;

  if (!VERSION.test(version) || version === "ff") return null;
  if (!TRACE_ID.test(traceId) || traceId === ALL_ZERO_TRACE) return null;
  if (!SPAN_ID.test(spanId) || spanId === ALL_ZERO_SPAN) return null;
  if (!FLAGS.test(flags)) return null;

  if (version === "00") {
    // Version 00 is exactly four fields and exactly 55 characters.
    if (parts.length !== 4 || value.length !== TRACEPARENT_LENGTH) return null;
  } else if (value.length > TRACEPARENT_LENGTH && value[TRACEPARENT_LENGTH] !== "-") {
    // Future versions may append "-"-prefixed fields; the fixed part must still
    // be followed by a separator.
    return null;
  }

  return {
    traceId,
    spanId,
    flags,
    tracestate: sanitizeTracestate(tracestate),
  };
}

/**
 * Validates a `tracestate` header, returning it unchanged when valid and
 * `undefined` otherwise. A partially valid list is dropped whole: the spec
 * allows a vendor to discard an invalid tracestate, and silently keeping a
 * subset would reorder or alter other vendors' state.
 */
export function sanitizeTracestate(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value.join(",") : value;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  if (raw.length > TRACESTATE_MAX_LENGTH) return undefined;

  const members = raw.split(",").map((member) => member.trim()).filter(Boolean);
  if (members.length === 0 || members.length > TRACESTATE_MAX_MEMBERS) return undefined;

  const seen = new Set<string>();
  for (const member of members) {
    const eq = member.indexOf("=");
    if (eq <= 0) return undefined;
    const key = member.slice(0, eq);
    const val = member.slice(eq + 1);
    if (!TRACESTATE_KEY.test(key) || !TRACESTATE_VALUE.test(val)) return undefined;
    if (seen.has(key)) return undefined;
    seen.add(key);
  }
  return members.join(",");
}

/** Formats the `traceparent` header for `context` (version 00). */
export function formatTraceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.flags}`;
}

// ─── Ambient context ──────────────────────────────────────────────────────

const storage = new AsyncLocalStorage<TraceContext>();

/** The active trace context, or `undefined` outside any trace. */
export function currentTraceContext(): TraceContext | undefined {
  return storage.getStore();
}

export function runWithTraceContext<T>(context: TraceContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * The carrier fields to persist alongside a durable record created now, or
 * nulls when no trace is active. Spread into a Prisma `data` object.
 *
 * The persisted `traceparent` is the CURRENT span's, so whatever later picks the
 * record up becomes a child of the span that enqueued it.
 */
export function currentTraceCarrier(): {
  traceparent: string | null;
  tracestate: string | null;
} {
  const ctx = storage.getStore();
  return {
    traceparent: ctx ? formatTraceparent(ctx) : null,
    tracestate: ctx?.tracestate ?? null,
  };
}

/**
 * The enqueuing span recorded in persisted carrier fields, or `undefined` when
 * they are absent or invalid. Pass it as the `parent` of {@link withSpan}: an
 * invalid carrier then starts a brand-new trace, so a corrupted or tampered row
 * can never break processing or inject a forged trace id.
 */
export function parentFromCarrier(carrier: {
  traceparent?: string | null;
  tracestate?: string | null;
}): TraceContext | undefined {
  return (
    parseTraceparent(carrier.traceparent ?? undefined, carrier.tracestate ?? undefined) ??
    undefined
  );
}

// ─── Spans ────────────────────────────────────────────────────────────────

/**
 * Span attribute keys that may be recorded. A closed allowlist: a new attribute
 * is a deliberate, reviewed addition, never an accident of passing an object.
 * None of these identifies a person, organization, wallet or proof.
 */
export const ALLOWED_SPAN_ATTRIBUTES: ReadonlySet<string> = new Set([
  "http.method",
  "http.route",
  "http.status_class",
  "job.name",
  "job.operation",
  "job.attempt",
  "contract.operation",
  "webhook.attempt",
  "webhook.event_type",
  "outcome",
]);

const MAX_ATTRIBUTE_STRING = 64;

// Shapes that must never appear as a value, even under an allowed key.
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /\b[GMS][A-Z2-7]{55}\b/, // Stellar account, muxed account, secret seed
  /\bC[A-Z2-7]{55}\b/, // contract id
  /[^\s@]+@[^\s@]+\.[^\s@]+/, // email address
  /https?:\/\//i, // URL (webhook destinations, RPC endpoints)
  /\b[0-9a-f]{64}\b/i, // hashes, transaction ids, keys
  /\bc[a-z0-9]{24}\b/, // cuid record ids
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, // uuid
];

export type SpanAttributeValue = string | number | boolean;

export interface FinishedSpan {
  name: string;
  context: TraceContext;
  startTimeMs: number;
  endTimeMs: number;
  attributes: Record<string, SpanAttributeValue>;
  status: "ok" | "error";
}

export interface SpanExporter {
  export(span: FinishedSpan): void;
}

let exporter: SpanExporter | undefined;

/**
 * Installs the exporter that receives finished spans (an OpenTelemetry bridge
 * in production, an in-memory collector in tests). `undefined` disables export;
 * context propagation is unaffected.
 */
export function setSpanExporter(next: SpanExporter | undefined): void {
  exporter = next;
}

/** Hands a finished span to the exporter. Telemetry never fails the operation. */
export function emitSpan(span: FinishedSpan): void {
  try {
    exporter?.export(span);
  } catch {
    // Swallowed by design.
  }
}

/** Returns the attribute value if it is safe to record, else `undefined`. */
export function sanitizeAttribute(
  key: string,
  value: unknown,
): SpanAttributeValue | undefined {
  if (!ALLOWED_SPAN_ATTRIBUTES.has(key)) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  if (value.length > MAX_ATTRIBUTE_STRING) return undefined;
  if (SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value))) return undefined;
  return value;
}

export interface ActiveSpan {
  readonly context: TraceContext;
  setAttribute(key: string, value: unknown): void;
}

/**
 * Runs `fn` inside a child span of the active trace (or a new root span when
 * none is active). The span ends, and is exported, whether `fn` resolves or
 * throws. Exporter failures never affect the operation.
 *
 * Attributes are filtered through {@link sanitizeAttribute}: a key outside the
 * allowlist, or a value shaped like an identifier, is dropped, not recorded.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, unknown>,
  fn: (span: ActiveSpan) => Promise<T> | T,
  options: { parent?: TraceContext | null } = {},
): Promise<T> {
  // An explicit `parent` (restored from a durable record) wins over the ambient
  // context; `null` forces a new root trace.
  const parent =
    options.parent === undefined ? storage.getStore() : (options.parent ?? undefined);
  const context = parent ? childContext(parent) : newTraceContext();
  const recorded: Record<string, SpanAttributeValue> = {};
  const set = (key: string, value: unknown) => {
    const safe = sanitizeAttribute(key, value);
    if (safe !== undefined) recorded[key] = safe;
  };
  for (const [key, value] of Object.entries(attributes)) set(key, value);

  const startTimeMs = Date.now();
  let status: FinishedSpan["status"] = "ok";
  try {
    return await storage.run(context, () => fn({ context, setAttribute: set }));
  } catch (error) {
    status = "error";
    throw error;
  } finally {
    emitSpan({
      name,
      context,
      startTimeMs,
      endTimeMs: Date.now(),
      attributes: recorded,
      status,
    });
  }
}

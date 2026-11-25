import { EventEmitter } from "events";
import { TraceContextMiddleware } from "./trace-context.middleware";
import {
  FinishedSpan,
  currentTraceContext,
  setSpanExporter,
  TraceContext,
} from "./trace-context";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";
const VALID = `00-${TRACE}-${SPAN}-01`;

function run(headers: Record<string, string | string[]>, route = "/proofs/:id") {
  const res = Object.assign(new EventEmitter(), { statusCode: 200 });
  const req = { headers, method: "GET", url: "/proofs/secret-proof-id", route: { path: route } };
  let seen: TraceContext | undefined;
  let asyncSeen: TraceContext | undefined;

  const done = new Promise<void>((resolve) => {
    new TraceContextMiddleware().use(req as never, res as never, () => {
      seen = currentTraceContext();
      setTimeout(() => {
        asyncSeen = currentTraceContext();
        resolve();
      }, 1);
    });
  });
  return {
    res,
    done,
    get seen() {
      return seen;
    },
    get asyncSeen() {
      return asyncSeen;
    },
  };
}

describe("TraceContextMiddleware", () => {
  const spans: FinishedSpan[] = [];
  beforeEach(() => {
    spans.length = 0;
    setSpanExporter({ export: (s) => void spans.push(s) });
  });
  afterEach(() => setSpanExporter(undefined));

  it("continues a valid inbound trace as a child span (parent-child continuity)", async () => {
    const r = run({ traceparent: VALID });
    await r.done;

    expect(r.seen?.traceId).toBe(TRACE);
    expect(r.seen?.parentSpanId).toBe(SPAN);
    expect(r.seen?.spanId).not.toBe(SPAN);
  });

  it("keeps the context across async boundaries in the handler", async () => {
    const r = run({ traceparent: VALID });
    await r.done;
    expect(r.asyncSeen?.spanId).toBe(r.seen?.spanId);
  });

  it("carries a valid tracestate and drops an invalid one", async () => {
    const good = run({ traceparent: VALID, tracestate: "vendor=1" });
    await good.done;
    expect(good.seen?.tracestate).toBe("vendor=1");

    const bad = run({ traceparent: VALID, tracestate: "garbage value" });
    await bad.done;
    expect(bad.seen?.traceId).toBe(TRACE);
    expect(bad.seen?.tracestate).toBeUndefined();
  });

  it.each([
    ["missing", {}],
    ["malformed", { traceparent: "not-a-traceparent" }],
    ["all-zero trace id", { traceparent: `00-${"0".repeat(32)}-${SPAN}-01` }],
    ["uppercase", { traceparent: VALID.toUpperCase() }],
    ["oversized", { traceparent: "0".repeat(10_000) }],
    ["repeated header", { traceparent: [VALID, VALID] }],
  ])("starts a fresh trace for a %s traceparent (invalid context)", async (_n, headers) => {
    const r = run(headers as Record<string, string | string[]>);
    await r.done;

    expect(r.seen?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(r.seen?.traceId).not.toBe(TRACE);
    expect(r.seen?.parentSpanId).toBeUndefined();
  });

  it("never reuses an attacker-chosen trace id from an invalid header", async () => {
    const forged = `00-${TRACE}-${"0".repeat(16)}-01`;
    const r = run({ traceparent: forged });
    await r.done;
    expect(r.seen?.traceId).not.toBe(TRACE);
  });

  it("emits a server span with the route template and no concrete URL or id", async () => {
    const r = run({ traceparent: VALID });
    await r.done;
    r.res.emit("finish");

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      name: "http.server",
      status: "ok",
      attributes: { "http.method": "GET", "http.route": "/proofs/:id", "http.status_class": "2xx" },
    });
    expect(spans[0].context.parentSpanId).toBe(SPAN);
    expect(JSON.stringify(spans[0])).not.toContain("secret-proof-id");
  });

  it("marks 5xx responses as errors", async () => {
    const r = run({});
    await r.done;
    r.res.statusCode = 503;
    r.res.emit("finish");
    expect(spans[0]).toMatchObject({ status: "error", attributes: { "http.status_class": "5xx" } });
  });

  it("does not leave a context behind after the request", async () => {
    const r = run({ traceparent: VALID });
    await r.done;
    expect(currentTraceContext()).toBeUndefined();
  });
});

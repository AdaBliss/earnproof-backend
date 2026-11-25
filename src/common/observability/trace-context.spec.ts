import {
  ALLOWED_SPAN_ATTRIBUTES,
  FinishedSpan,
  childContext,
  currentTraceCarrier,
  currentTraceContext,
  formatTraceparent,
  newTraceContext,
  parentFromCarrier,
  parseTraceparent,
  runWithTraceContext,
  sanitizeAttribute,
  sanitizeTracestate,
  setSpanExporter,
  withSpan,
} from "./trace-context";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";
const VALID = `00-${TRACE}-${SPAN}-01`;

describe("parseTraceparent", () => {
  it("parses the W3C specification example", () => {
    expect(parseTraceparent(VALID)).toEqual({
      traceId: TRACE,
      spanId: SPAN,
      flags: "01",
      tracestate: undefined,
    });
  });

  it("preserves the sampled flag", () => {
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-00`)?.flags).toBe("00");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an object", {}],
    ["an array", [VALID]],
    ["empty", ""],
    ["too short", `00-${TRACE}-${SPAN}-0`],
    ["uppercase hex", `00-${TRACE.toUpperCase()}-${SPAN}-01`],
    ["uppercase span", `00-${TRACE}-${SPAN.toUpperCase()}-01`],
    ["forbidden version ff", `ff-${TRACE}-${SPAN}-01`],
    ["non-hex version", `zz-${TRACE}-${SPAN}-01`],
    ["all-zero trace id", `00-${"0".repeat(32)}-${SPAN}-01`],
    ["all-zero span id", `00-${TRACE}-${"0".repeat(16)}-01`],
    ["short trace id", `00-${TRACE.slice(1)}-${SPAN}-01`],
    ["long span id", `00-${TRACE}-${SPAN}0-01`],
    ["non-hex flags", `00-${TRACE}-${SPAN}-zz`],
    ["trailing field on version 00", `00-${TRACE}-${SPAN}-01-extra`],
    ["leading whitespace", ` ${VALID}`],
    ["trailing whitespace", `${VALID} `],
    ["wrong separator", `00_${TRACE}_${SPAN}_01`],
    ["newline injection", `${VALID}\nx-injected: 1`],
    ["very long", `00-${TRACE}-${SPAN}-01${"-a".repeat(400)}`],
  ])("rejects %s", (_name, value) => {
    expect(parseTraceparent(value)).toBeNull();
  });

  it("accepts a future version that appends a separated field", () => {
    expect(parseTraceparent(`01-${TRACE}-${SPAN}-01-future`)?.traceId).toBe(TRACE);
  });

  it("rejects a future version whose extra data is not separated", () => {
    expect(parseTraceparent(`01-${TRACE}-${SPAN}-01xfuture`)).toBeNull();
  });

  it("attaches a valid tracestate and drops an invalid one without rejecting the trace", () => {
    expect(parseTraceparent(VALID, "vendor=abc")?.tracestate).toBe("vendor=abc");
    const dropped = parseTraceparent(VALID, "not valid");
    expect(dropped?.traceId).toBe(TRACE);
    expect(dropped?.tracestate).toBeUndefined();
  });
});

describe("sanitizeTracestate", () => {
  it("accepts valid lists, including tenant@system keys", () => {
    expect(sanitizeTracestate("a=1,b=2")).toBe("a=1,b=2");
    expect(sanitizeTracestate("tenant@vendor=value")).toBe("tenant@vendor=value");
  });

  it("joins repeated header values", () => {
    expect(sanitizeTracestate(["a=1", "b=2"])).toBe("a=1,b=2");
  });

  it.each([
    ["empty", ""],
    ["no equals", "novalue"],
    ["empty key", "=v"],
    ["uppercase key", "Key=v"],
    ["duplicate key", "a=1,a=2"],
    ["equals sign in value", "a=b=c"],
    ["comma-only", ","],
    ["control char", "a=b\u0001"],
    ["CRLF", "a=b\r\nx=y"],
    ["non-string", 5],
  ])("rejects %s", (_n, value) => {
    expect(sanitizeTracestate(value)).toBeUndefined();
  });

  it("rejects more than 32 members and more than 512 characters", () => {
    const members = Array.from({ length: 33 }, (_, i) => `k${i}=v`).join(",");
    expect(sanitizeTracestate(members)).toBeUndefined();
    expect(sanitizeTracestate(`a=${"x".repeat(520)}`)).toBeUndefined();
  });

  it("accepts exactly 32 members", () => {
    const members = Array.from({ length: 32 }, (_, i) => `k${i}=v`).join(",");
    expect(sanitizeTracestate(members)).toBe(members);
  });
});

describe("contexts", () => {
  it("newTraceContext produces valid, non-zero ids", () => {
    const ctx = newTraceContext();
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(parseTraceparent(formatTraceparent(ctx))).not.toBeNull();
  });

  it("childContext keeps the trace, links the parent and takes a new span id", () => {
    const parent = newTraceContext();
    const child = childContext(parent);
    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(child.spanId).not.toBe(parent.spanId);
    expect(child.flags).toBe(parent.flags);
  });

  it("round-trips through format and parse", () => {
    const ctx = newTraceContext();
    const parsed = parseTraceparent(formatTraceparent(ctx));
    expect(parsed).toMatchObject({ traceId: ctx.traceId, spanId: ctx.spanId });
  });
});

describe("durable carrier", () => {
  it("is null outside a trace", () => {
    expect(currentTraceCarrier()).toEqual({ traceparent: null, tracestate: null });
  });

  it("captures the active span and tracestate", () => {
    const ctx = { ...newTraceContext(), tracestate: "v=1" };
    const carrier = runWithTraceContext(ctx, () => currentTraceCarrier());
    expect(carrier).toEqual({ traceparent: formatTraceparent(ctx), tracestate: "v=1" });
  });

  it("fits the database column widths", () => {
    const carrier = runWithTraceContext(newTraceContext(), () => currentTraceCarrier());
    expect(carrier.traceparent?.length).toBe(55);
  });

  it("restores the enqueuing span as parent", () => {
    const ctx = newTraceContext();
    const carrier = runWithTraceContext(ctx, () => currentTraceCarrier());
    expect(parentFromCarrier(carrier)).toMatchObject({ traceId: ctx.traceId, spanId: ctx.spanId });
  });

  it.each([
    [{ traceparent: null }],
    [{ traceparent: "garbage" }],
    [{ traceparent: `00-${"0".repeat(32)}-${SPAN}-01` }],
    [{}],
  ])("treats an invalid or absent carrier %j as no parent", (carrier) => {
    expect(parentFromCarrier(carrier)).toBeUndefined();
  });
});

describe("sanitizeAttribute", () => {
  it("rejects keys outside the allowlist", () => {
    for (const key of ["proofId", "walletAddress", "organizationId", "userId", "url", "email", "apiKey"]) {
      expect(sanitizeAttribute(key, "x")).toBeUndefined();
    }
  });

  it("accepts every allowlisted key with a plain value", () => {
    for (const key of ALLOWED_SPAN_ATTRIBUTES) {
      expect(sanitizeAttribute(key, "plain")).toBe("plain");
    }
  });

  it.each([
    ["a Stellar account", "G" + "A".repeat(55)],
    ["a Stellar secret seed", "S" + "B".repeat(55)],
    ["a contract id", "C" + "A".repeat(55)],
    ["an email", "someone@example.com"],
    ["a URL", "https://hooks.example.com/abc"],
    ["a 64-char hash", "a".repeat(64)],
    ["a cuid", "clh3x9k2a0000qwerty1234ab"],
    ["a uuid", "123e4567-e89b-12d3-a456-426614174000"],
  ])("drops a value that looks like %s even under an allowed key", (_n, value) => {
    expect(sanitizeAttribute("outcome", value)).toBeUndefined();
    expect(sanitizeAttribute("outcome", `prefix ${value} suffix`)).toBeUndefined();
  });

  it("drops oversized strings, non-finite numbers and unsupported types", () => {
    expect(sanitizeAttribute("outcome", "x".repeat(65))).toBeUndefined();
    expect(sanitizeAttribute("job.attempt", NaN)).toBeUndefined();
    expect(sanitizeAttribute("job.attempt", Infinity)).toBeUndefined();
    expect(sanitizeAttribute("outcome", { a: 1 })).toBeUndefined();
    expect(sanitizeAttribute("outcome", null)).toBeUndefined();
  });

  it("keeps numbers and booleans", () => {
    expect(sanitizeAttribute("job.attempt", 3)).toBe(3);
    expect(sanitizeAttribute("outcome", true)).toBe(true);
  });
});

describe("withSpan", () => {
  const spans: FinishedSpan[] = [];
  beforeEach(() => {
    spans.length = 0;
    setSpanExporter({ export: (s) => void spans.push(s) });
  });
  afterEach(() => setSpanExporter(undefined));

  it("starts a new root trace when none is active", async () => {
    await withSpan("root", {}, () => undefined);
    expect(spans).toHaveLength(1);
    expect(spans[0].context.parentSpanId).toBeUndefined();
  });

  it("makes nested spans children of the active span, across async hops", async () => {
    await withSpan("outer", {}, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await withSpan("inner", {}, async () => {
        await Promise.resolve();
        await withSpan("leaf", {}, () => undefined);
      });
    });

    const byName = Object.fromEntries(spans.map((s) => [s.name, s]));
    expect(byName.inner.context.parentSpanId).toBe(byName.outer.context.spanId);
    expect(byName.leaf.context.parentSpanId).toBe(byName.inner.context.spanId);
    expect(new Set(spans.map((s) => s.context.traceId)).size).toBe(1);
  });

  it("uses an explicit parent over the ambient context, and null forces a new trace", async () => {
    const remote = newTraceContext();
    await runWithTraceContext(newTraceContext(), () =>
      withSpan("from-remote", {}, () => undefined, { parent: remote }),
    );
    await runWithTraceContext(newTraceContext(), () =>
      withSpan("fresh", {}, () => undefined, { parent: null }),
    );

    const remoteSpan = spans.find((s) => s.name === "from-remote")!;
    expect(remoteSpan.context.traceId).toBe(remote.traceId);
    expect(remoteSpan.context.parentSpanId).toBe(remote.spanId);
    const fresh = spans.find((s) => s.name === "fresh")!;
    expect(fresh.context.parentSpanId).toBeUndefined();
  });

  it("restores the previous context afterwards", async () => {
    const outer = newTraceContext();
    await runWithTraceContext(outer, async () => {
      await withSpan("inner", {}, () => undefined);
      expect(currentTraceContext()).toBe(outer);
    });
    expect(currentTraceContext()).toBeUndefined();
  });

  it("records only safe attributes", async () => {
    await withSpan(
      "op",
      {
        "job.name": "worker",
        proofId: "proof_secret",
        "job.operation": "G" + "A".repeat(55),
        "job.attempt": 2,
      },
      (span) => {
        span.setAttribute("walletAddress", "GABC");
        span.setAttribute("outcome", "success");
      },
    );
    expect(spans[0].attributes).toEqual({ "job.name": "worker", "job.attempt": 2, outcome: "success" });
    expect(JSON.stringify(spans[0])).not.toContain("proof_secret");
  });

  it("marks failures as errors, still exports, and rethrows", async () => {
    await expect(
      withSpan("boom", {}, () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(spans[0]).toMatchObject({ name: "boom", status: "error" });
  });

  it("never lets a failing exporter affect the operation", async () => {
    setSpanExporter({
      export: () => {
        throw new Error("collector down");
      },
    });
    await expect(withSpan("op", {}, () => "value")).resolves.toBe("value");
  });

  it("works with no exporter installed", async () => {
    setSpanExporter(undefined);
    await expect(withSpan("op", {}, () => 1)).resolves.toBe(1);
  });
});

import { WebhookDeliveryStatus } from "@prisma/client";
import { encryptProtectedAmount } from "../common/crypto/protected-amount";
import {
  FinishedSpan,
  formatTraceparent,
  newTraceContext,
  parseTraceparent,
  setSpanExporter,
} from "../common/observability/trace-context";
import { WebhookDeliveryService } from "./webhook-delivery.service";
import { WebhookSigningService } from "./webhook-signing.service";

// Destination safety is covered by webhook-ssrf-guard.spec.ts; here DNS must not
// be consulted so the test is deterministic offline.
jest.mock("./webhook-ssrf-guard", () => ({
  ...jest.requireActual("./webhook-ssrf-guard"),
  assertSafeWebhookDestination: jest.fn().mockResolvedValue(undefined),
}));

const KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const secretEncrypted = encryptProtectedAmount("test-raw-signing-secret-32bytes!", new Map([[0, KEY]]), 0);
const config = {
  getOrThrow: jest.fn((k: string) => {
    if (k === "paymentEncryptionKey") return KEY;
    throw new Error(`Unexpected config key: ${k}`);
  }),
  get: jest.fn(() => undefined),
};

function setup(carrier: Record<string, unknown>, attempt = 1) {
  const rows = new Map<string, Record<string, unknown>>();
  const webhook = { id: "webhook_1", url: "https://integrator.example/hook", secretEncrypted, status: "ACTIVE" };
  rows.set("d1", {
    id: "d1",
    webhookId: "webhook_1",
    eventType: "proof.created",
    eventId: "event_1",
    schemaVersion: "1",
    payloadBody: JSON.stringify({ id: "event_1" }),
    attempt,
    status: WebhookDeliveryStatus.PENDING,
    replayOf: null,
    createdAt: new Date(),
    webhook,
    ...carrier,
  });
  const prisma = {
    webhookDelivery: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve(rows.get(where.id) ?? null)),
      update: jest.fn(({ where, data }: { where: { id: string }; data: object }) => {
        rows.set(where.id, { ...rows.get(where.id), ...data });
        return Promise.resolve(rows.get(where.id));
      }),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const id = `d${rows.size + 1}`;
        rows.set(id, { ...data, id });
        return Promise.resolve({ id });
      }),
    },
    webhook: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const service = new WebhookDeliveryService(
    prisma as never,
    new WebhookSigningService(),
    { selectActiveCertificate: jest.fn() } as never,
    undefined,
    undefined,
    config as never,
  );
  return { service, rows, prisma };
}

function respond(status: number) {
  const fetchMock = jest.fn().mockResolvedValue({ ok: status < 400, status, text: async () => "OK" });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const send = (service: WebhookDeliveryService) =>
  (service as unknown as { runDelivery: (id: string) => Promise<void> }).runDelivery("d1");

describe("webhook delivery trace propagation", () => {
  const spans: FinishedSpan[] = [];
  beforeEach(() => {
    spans.length = 0;
    setSpanExporter({ export: (s) => void spans.push(s) });
  });
  afterEach(() => setSpanExporter(undefined));

  it("sends a traceparent that continues the trace that created the delivery", async () => {
    const origin = newTraceContext();
    const { service } = setup({ traceparent: formatTraceparent(origin), tracestate: "vendor=1" });
    const fetchMock = respond(200);

    await send(service);

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    const sent = parseTraceparent(headers.traceparent);
    expect(sent?.traceId).toBe(origin.traceId);
    expect(sent?.spanId).not.toBe(origin.spanId);
    expect(headers.tracestate).toBe("vendor=1");

    const span = spans.find((s) => s.name === "webhook.deliver")!;
    expect(span.context.spanId).toBe(sent?.spanId);
    expect(span.context.parentSpanId).toBe(origin.spanId);
    expect(span.status).toBe("ok");
  });

  it("starts a new trace for a legacy row and sends a valid traceparent", async () => {
    const { service } = setup({});
    const fetchMock = respond(200);

    await send(service);

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(parseTraceparent(headers.traceparent)).not.toBeNull();
    expect(headers).not.toHaveProperty("tracestate");
  });

  it("never forwards a corrupt stored carrier to the integrator", async () => {
    const { service } = setup({ traceparent: "garbage\r\nX-Injected: 1", tracestate: "bad value" });
    const fetchMock = respond(200);

    await send(service);

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(JSON.stringify(headers)).not.toContain("X-Injected");
    expect(headers).not.toHaveProperty("tracestate");
  });

  it("keeps the trace headers out of the signed material", async () => {
    const origin = newTraceContext();
    const a = setup({ traceparent: formatTraceparent(origin) });
    const b = setup({});
    const fetchA = respond(200);
    await send(a.service);
    const fetchB = respond(200);
    await send(b.service);

    // Same body and event id: signatures differ only by timestamp, never by trace.
    const sigA = (fetchA.mock.calls[0][1].headers as Record<string, string>)["X-EarnProof-Signature"];
    const sigB = (fetchB.mock.calls[0][1].headers as Record<string, string>)["X-EarnProof-Signature"];
    expect(sigA).toMatch(/^[a-z0-9=:,]+$/i);
    expect(sigB).toMatch(/^[a-z0-9=:,]+$/i);
    expect(fetchA.mock.calls[0][1].body).toBe(fetchB.mock.calls[0][1].body);
  });

  it("makes the retry delivery inherit the original trace so all attempts share one trace", async () => {
    const origin = newTraceContext();
    const { service, rows } = setup({ traceparent: formatTraceparent(origin), tracestate: "vendor=1" });
    respond(500);

    await send(service);

    const retry = [...rows.values()].find((r) => r.id !== "d1")!;
    expect(retry.attempt).toBe(2);
    expect(retry.traceparent).toBe(formatTraceparent(origin));
    expect(retry.tracestate).toBe("vendor=1");
  });

  it("records an error span for a failed attempt without sensitive attributes", async () => {
    const { service } = setup({ traceparent: formatTraceparent(newTraceContext()) });
    respond(500);

    await send(service);

    const span = spans.find((s) => s.name === "webhook.deliver")!;
    expect(span.status).toBe("error");
    expect(span.attributes).toEqual({
      "webhook.attempt": 1,
      "webhook.event_type": "proof.created",
      outcome: "failure",
    });
    const serialized = JSON.stringify(spans);
    expect(serialized).not.toContain("integrator.example");
    expect(serialized).not.toContain("webhook_1");
    expect(serialized).not.toContain("event_1");
  });
});

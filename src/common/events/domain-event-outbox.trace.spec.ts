import {
  FinishedSpan,
  TraceContext,
  currentTraceContext,
  formatTraceparent,
  newTraceContext,
  runWithTraceContext,
  setSpanExporter,
} from "../observability/trace-context";
import { DomainEventOutboxService } from "./domain-event-outbox.service";

function build() {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    domainEventOutbox: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return Promise.resolve({ id: "evt_1", ...data });
      }),
    },
  };
  const service = new DomainEventOutboxService(prisma as never);
  return { service, prisma, created };
}

const input = {
  organizationId: "org_1",
  eventType: "proof.created",
  aggregateType: "Proof",
  aggregateId: "proof_1",
  payload: { ok: true },
};

describe("DomainEventOutboxService trace propagation", () => {
  const spans: FinishedSpan[] = [];
  beforeEach(() => {
    spans.length = 0;
    setSpanExporter({ export: (s) => void spans.push(s) });
  });
  afterEach(() => setSpanExporter(undefined));

  it("persists the active trace context with the event", async () => {
    const { service, created } = build();
    const ctx = { ...newTraceContext(), tracestate: "vendor=1" };

    await runWithTraceContext(ctx, () => service.publish({} as never, input));

    expect(created[0]).toMatchObject({
      traceparent: formatTraceparent(ctx),
      tracestate: "vendor=1",
    });
  });

  it("persists nulls when published outside any trace", async () => {
    const { service, created } = build();
    await service.publish({} as never, input);
    expect(created[0]).toMatchObject({ traceparent: null, tracestate: null });
  });

  describe("consumption", () => {
    function consume(event: Record<string, unknown>) {
      const { service } = build();
      let seen: TraceContext | undefined;
      const internals = service as unknown as {
        consumers: Map<string, unknown[]>;
        claimBatch: jest.Mock;
        processEventWithConsumer: jest.Mock;
      };
      internals.consumers = new Map([["proof.created", [{ name: "c", handle: jest.fn() }]]]);
      internals.claimBatch = jest.fn().mockResolvedValue([{ id: "evt_1", eventType: "proof.created", ...event }]);
      internals.processEventWithConsumer = jest.fn().mockImplementation(async () => {
        seen = currentTraceContext();
        return { outcome: "processed", eventId: "evt_1", consumerName: "c" };
      });
      return { run: () => service.processBatch("owner", 1), get seen() { return seen; } };
    }

    it("runs consumers as a child of the span that published the event", async () => {
      const publisher = newTraceContext();
      const c = consume({ traceparent: formatTraceparent(publisher), tracestate: null });

      await c.run();

      expect(c.seen?.traceId).toBe(publisher.traceId);
      expect(c.seen?.parentSpanId).toBe(publisher.spanId);
      const span = spans.find((s) => s.name === "outbox.consume")!;
      expect(span.context.parentSpanId).toBe(publisher.spanId);
    });

    it.each([
      ["garbage", { traceparent: "garbage" }],
      ["null", { traceparent: null }],
      ["absent", {}],
    ])("starts a fresh trace and still processes the event for a %s carrier", async (_n, carrier) => {
      const c = consume(carrier);

      const outcomes = await c.run();

      expect(outcomes[0].outcome).toBe("processed");
      expect(c.seen?.parentSpanId).toBeUndefined();
    });
  });
});

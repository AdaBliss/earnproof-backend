import { AnchoringOperation, AnchoringStatus } from "@prisma/client";
import { AnchoringWorkerService } from "./anchoring-worker.service";
import {
  FinishedSpan,
  TraceContext,
  currentTraceContext,
  formatTraceparent,
  newTraceContext,
  setSpanExporter,
} from "../common/observability/trace-context";

function makePrisma(carrier: Record<string, unknown>) {
  const intent = {
    id: "intent_1",
    proofId: "proof_secret_1",
    operation: AnchoringOperation.REGISTER,
    status: AnchoringStatus.PENDING,
    attemptCount: 0,
    proof: { commitment: "sha256:abc", expiresAt: new Date("2027-01-01") },
    ...carrier,
  };
  return {
    anchoringIntent: {
      findUnique: jest.fn().mockResolvedValue(intent),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(intent),
    },
    proof: { update: jest.fn() },
    $transaction: jest.fn().mockResolvedValue([]),
  };
}

const config = { get: (k: string) => (k === "contractAnchoring.enabled" ? true : undefined) };

describe("AnchoringWorkerService trace propagation across the durable queue", () => {
  const spans: FinishedSpan[] = [];
  beforeEach(() => {
    spans.length = 0;
    setSpanExporter({ export: (s) => void spans.push(s) });
  });
  afterEach(() => setSpanExporter(undefined));

  function run(carrier: Record<string, unknown>) {
    let inContract: TraceContext | undefined;
    const anchoring = {
      anchorProof: jest.fn().mockImplementation(async () => {
        inContract = currentTraceContext();
        return { anchored: true, transactionHash: "tx_1" };
      }),
      revokeProof: jest.fn(),
      circuitState: jest.fn().mockReturnValue("closed"),
    };
    const worker = new AnchoringWorkerService(
      makePrisma(carrier) as never,
      anchoring as never,
      config as never,
    );
    return {
      worker,
      get inContract() {
        return inContract;
      },
    };
  }

  it("continues the enqueuing request trace: the job span is its child", async () => {
    const enqueuer = newTraceContext();
    const r = run({ traceparent: formatTraceparent(enqueuer), tracestate: null });

    await r.worker.processIntent("intent_1");

    const job = spans.find((s) => s.name === "anchoring.execute")!;
    expect(job.context.traceId).toBe(enqueuer.traceId);
    expect(job.context.parentSpanId).toBe(enqueuer.spanId);
    // The contract layer runs inside the job span.
    expect(r.inContract?.spanId).toBe(job.context.spanId);
  });

  it("restores tracestate from the durable row", async () => {
    const enqueuer = newTraceContext();
    const r = run({ traceparent: formatTraceparent(enqueuer), tracestate: "vendor=1" });
    await r.worker.processIntent("intent_1");
    expect(r.inContract?.tracestate).toBe("vendor=1");
  });

  it.each([
    ["null", { traceparent: null }],
    ["garbage", { traceparent: "garbage" }],
    ["all-zero", { traceparent: `00-${"0".repeat(32)}-${"1".repeat(16)}-01` }],
    ["absent (legacy row)", {}],
  ])("starts a fresh trace and still processes the intent for a %s carrier", async (_n, carrier) => {
    const r = run(carrier);

    await r.worker.processIntent("intent_1");

    const job = spans.find((s) => s.name === "anchoring.execute")!;
    expect(job.context.parentSpanId).toBeUndefined();
    expect(job.status).toBe("ok");
  });

  it("records no sensitive identifier as a span attribute", async () => {
    const r = run({ traceparent: formatTraceparent(newTraceContext()) });
    await r.worker.processIntent("intent_1");

    const serialized = JSON.stringify(spans);
    expect(serialized).not.toContain("proof_secret_1");
    expect(serialized).not.toContain("intent_1");
    expect(spans.find((s) => s.name === "anchoring.execute")!.attributes).toEqual({
      "job.name": "anchoring-worker",
      "job.operation": "REGISTER",
      "job.attempt": 1,
    });
  });
});

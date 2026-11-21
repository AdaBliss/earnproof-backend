import { ConfigService } from "@nestjs/config";
import { SorobanRpcClient, SorobanRpcError } from "./soroban-rpc.client";

const URL_WITH_KEY = "https://rpc.example.invalid/?apikey=SUPERSECRETKEY";

function client(url: string | undefined = URL_WITH_KEY, timeoutMs = 50) {
  const values: Record<string, unknown> = {
    "contractAnchoring.sorobanRpcUrl": url,
    "contractAnchoring.rpcTimeoutMs": timeoutMs,
  };
  return new SorobanRpcClient({
    get: (key: string) => values[key],
  } as unknown as ConfigService);
}

function respond(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return jest.spyOn(global, "fetch").mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response);
}

describe("SorobanRpcClient", () => {
  afterEach(() => jest.restoreAllMocks());

  it("is not configured without a URL", () => {
    expect(client("").configured).toBe(false);
    expect(client(URL_WITH_KEY).configured).toBe(true);
  });

  it("posts a JSON-RPC request and returns the result", async () => {
    const fetchSpy = respond({ jsonrpc: "2.0", id: 1, result: { latestLedger: 7 } });

    const result = await client().simulateTransaction("AAAA");

    expect(result).toEqual({ latestLedger: 7 });
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      method: "simulateTransaction",
      params: { transaction: "AAAA" },
    });
  });

  it("classifies an HTTP error without leaking the URL", async () => {
    respond({}, { ok: false, status: 503 });

    const error = await client().getNetwork().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SorobanRpcError);
    expect(error).toMatchObject({ failure: "http" });
    expect((error as Error).message).not.toContain("SUPERSECRETKEY");
  });

  it("classifies a transport failure without leaking the URL", async () => {
    jest
      .spyOn(global, "fetch")
      .mockRejectedValue(new Error(`connect ECONNREFUSED ${URL_WITH_KEY}`));

    const error = await client().getNetwork().catch((e: unknown) => e);

    expect(error).toMatchObject({ failure: "transport" });
    expect((error as Error).message).not.toContain("SUPERSECRETKEY");
  });

  it.each([
    ["a JSON-RPC error object", { error: { code: -32602, message: "bad" } }],
    ["a body with no result", { jsonrpc: "2.0" }],
    ["a non-object body", "text"],
  ])("rejects %s as malformed", async (_label, body) => {
    respond(body);

    await expect(client().getNetwork()).rejects.toMatchObject({ failure: "malformed" });
  });

  it("rejects invalid JSON as malformed", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    } as unknown as Response);

    await expect(client().getNetwork()).rejects.toMatchObject({ failure: "malformed" });
  });

  it("aborts and reports a timeout when the RPC hangs", async () => {
    jest.spyOn(global, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal!.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );

    await expect(client(URL_WITH_KEY, 20).getNetwork()).rejects.toMatchObject({
      failure: "timeout",
    });
  });

  it("fails without a network call when unconfigured", async () => {
    const fetchSpy = jest.spyOn(global, "fetch");

    await expect(client("").getNetwork()).rejects.toMatchObject({ failure: "transport" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export type SorobanRpcFailure = "timeout" | "transport" | "http" | "malformed";

/**
 * Failure talking to the Soroban RPC. The message never contains the RPC URL
 * (providers commonly embed API keys in it) or the response body.
 */
export class SorobanRpcError extends Error {
  constructor(
    readonly failure: SorobanRpcFailure,
    message: string,
  ) {
    super(message);
    this.name = "SorobanRpcError";
  }
}

export const DEFAULT_SOROBAN_RPC_TIMEOUT_MS = 5_000;

/**
 * Minimal JSON-RPC client for the three Soroban RPC methods the anchoring path
 * needs. Every call is bounded by a hard timeout.
 */
@Injectable()
export class SorobanRpcClient {
  private readonly url: string | undefined;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.url = config.get<string>("contractAnchoring.sorobanRpcUrl") || undefined;
    this.timeoutMs =
      config.get<number>("contractAnchoring.rpcTimeoutMs") ??
      DEFAULT_SOROBAN_RPC_TIMEOUT_MS;
  }

  get configured(): boolean {
    return this.url !== undefined;
  }

  simulateTransaction(transactionXdr: string): Promise<unknown> {
    return this.call("simulateTransaction", { transaction: transactionXdr });
  }

  getNetwork(): Promise<unknown> {
    return this.call("getNetwork", undefined);
  }

  getLedgerEntries(keys: string[]): Promise<unknown> {
    return this.call("getLedgerEntries", { keys });
  }

  private async call(method: string, params: unknown): Promise<unknown> {
    if (!this.url) {
      throw new SorobanRpcError("transport", "Soroban RPC URL is not configured");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new SorobanRpcError(
          "http",
          `Soroban RPC ${method} returned HTTP ${response.status}`,
        );
      }
      const body: unknown = await response.json();
      if (
        typeof body !== "object" ||
        body === null ||
        !("result" in body) ||
        (body as { error?: unknown }).error !== undefined
      ) {
        throw new SorobanRpcError(
          "malformed",
          `Soroban RPC ${method} returned an unusable response`,
        );
      }
      return (body as { result: unknown }).result;
    } catch (error) {
      if (error instanceof SorobanRpcError) throw error;
      if (controller.signal.aborted) {
        throw new SorobanRpcError(
          "timeout",
          `Soroban RPC ${method} timed out after ${this.timeoutMs}ms`,
        );
      }
      if (error instanceof SyntaxError) {
        throw new SorobanRpcError(
          "malformed",
          `Soroban RPC ${method} returned invalid JSON`,
        );
      }
      throw new SorobanRpcError(
        "transport",
        `Soroban RPC ${method} request failed`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

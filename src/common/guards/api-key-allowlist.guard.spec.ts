import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { ApiKeyAllowlistGuard } from "./api-key-allowlist.guard";

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe("ApiKeyAllowlistGuard", () => {
  const guard = new ApiKeyAllowlistGuard();

  it("uses the verified Express client IP rather than a forwarded header", () => {
    const request = {
      apiKey: { allowlistCidrs: ["198.51.100.0/24"] },
      ip: "203.0.113.20",
      headers: { "x-forwarded-for": "198.51.100.20" },
    };

    expect(() => guard.canActivate(contextFor(request))).toThrow(
      ForbiddenException,
    );
  });

  it("allows an IP matched by the verified client address", () => {
    const request = {
      apiKey: { allowlistCidrs: ["198.51.100.0/24"] },
      ip: "198.51.100.20",
      headers: { "x-forwarded-for": "203.0.113.20" },
    };

    expect(guard.canActivate(contextFor(request))).toBe(true);
  });

  it("supports IPv6 allowlist CIDRs", () => {
    const request = {
      apiKey: { allowlistCidrs: ["2001:db8:abcd::/48"] },
      ip: "2001:db8:abcd::8",
      headers: {},
    };

    expect(guard.canActivate(contextFor(request))).toBe(true);
  });
});

import { BadRequestException } from "@nestjs/common";
import type { Request, Response } from "express";
import {
  clientIpPolicyMiddleware,
  createProxyTrustFunction,
} from "./client-ip-policy";

describe("client IP proxy policy", () => {
  const policy = {
    proxyHops: 2,
    trustedProxyCidrs: ["192.0.2.0/24", "198.51.100.0/24"],
  };

  function invokeMiddleware(
    remoteAddress: string,
    headers: Record<string, string | string[] | undefined>,
  ): { next: jest.Mock; request: Request } {
    const request = {
      socket: { remoteAddress },
      headers: { ...headers },
    } as unknown as Request;
    const next = jest.fn();
    clientIpPolicyMiddleware(policy)(
      request,
      {} as Response,
      next,
    );
    return { next, request };
  }

  it("trusts only configured proxy CIDRs within the configured hop count", () => {
    const trust = createProxyTrustFunction(policy);

    expect(trust("192.0.2.10", 0)).toBe(true);
    expect(trust("198.51.100.22", 1)).toBe(true);
    expect(trust("203.0.113.8", 0)).toBe(false);
    expect(trust("192.0.2.10", 2)).toBe(false);
  });

  it("strips forwarded headers received from an untrusted peer", () => {
    const { next, request } = invokeMiddleware("203.0.113.9", {
      "x-forwarded-for": "198.51.100.88",
      forwarded: "for=198.51.100.88",
      "x-real-ip": "198.51.100.88",
    });

    expect(next).toHaveBeenCalledWith();
    expect(request.headers["x-forwarded-for"]).toBeUndefined();
    expect(request.headers.forwarded).toBeUndefined();
    expect(request.headers["x-real-ip"]).toBeUndefined();
  });

  it("accepts a valid fixed-length chain from an approved proxy", () => {
    const { next } = invokeMiddleware("192.0.2.1", {
      "x-forwarded-for": "203.0.113.4, 198.51.100.2",
    });

    expect(next).toHaveBeenCalledWith();
  });

  it.each([
    ["missing chain", undefined],
    ["wrong hop count", "203.0.113.4"],
    ["invalid IP", "not-an-ip, 198.51.100.2"],
    ["untrusted intermediate proxy", "203.0.113.4, 203.0.113.5"],
  ])("rejects a trusted-proxy request with %s", (_label, forwarded) => {
    const { next } = invokeMiddleware("192.0.2.1", {
      "x-forwarded-for": forwarded,
    });

    expect(next).toHaveBeenCalledWith(expect.any(BadRequestException));
  });

  it("handles IPv4-mapped IPv6 proxy socket addresses", () => {
    const v4Policy = {
      proxyHops: 1,
      trustedProxyCidrs: ["127.0.0.1/32"],
    };
    const request = {
      socket: { remoteAddress: "::ffff:127.0.0.1" },
      headers: { "x-forwarded-for": "203.0.113.7" },
    } as unknown as Request;
    const next = jest.fn();

    clientIpPolicyMiddleware(v4Policy)(request, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
  });
});

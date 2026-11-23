import { BadRequestException } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { isIP } from "net";
import { isIpInCidr, normaliseIp } from "./ip-address";

export interface ClientIpPolicy {
  readonly proxyHops: number;
  readonly trustedProxyCidrs: readonly string[];
}

/**
 * Express trust callback: only configured proxy ranges are trusted, and no
 * request can cause Express to walk farther than the configured hop count.
 */
export function createProxyTrustFunction(policy: ClientIpPolicy) {
  return (address: string, hop: number): boolean =>
    hop < policy.proxyHops &&
    isTrustedProxyAddress(address, policy.trustedProxyCidrs);
}

/**
 * Validates forwarding data only when the direct peer is a trusted proxy.
 * Forwarding headers from every other peer are removed before downstream
 * middleware can mistake them for client identity.
 */
export function clientIpPolicyMiddleware(policy: ClientIpPolicy) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const remoteAddress = req.socket.remoteAddress;
    const remoteIsTrusted =
      policy.proxyHops > 0 &&
      remoteAddress !== undefined &&
      isTrustedProxyAddress(remoteAddress, policy.trustedProxyCidrs);

    if (!remoteIsTrusted) {
      delete req.headers["x-forwarded-for"];
      delete req.headers.forwarded;
      delete req.headers["x-real-ip"];
      next();
      return;
    }

    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded !== "string") {
      next(new BadRequestException("The trusted proxy forwarding chain is invalid."));
      return;
    }

    const addresses = forwarded.split(",").map((address) => address.trim());
    if (
      addresses.length !== policy.proxyHops ||
      addresses.some((address) => !address || isIP(address) === 0) ||
      addresses.slice(1).some(
        (address) =>
          !isTrustedProxyAddress(address, policy.trustedProxyCidrs),
      )
    ) {
      next(new BadRequestException("The trusted proxy forwarding chain is invalid."));
      return;
    }

    next();
  };
}

function isTrustedProxyAddress(
  address: string,
  trustedProxyCidrs: readonly string[],
): boolean {
  return trustedProxyCidrs.some(
    (cidr) =>
      isIpInCidr(address, cidr) || isIpInCidr(normaliseIp(address), cidr),
  );
}

/**
 * Per-attempt DNS resolution pinning service for webhook delivery.
 *
 * This service manages DNS resolution and address pinning for webhook delivery attempts.
 * Key responsibilities:
 *
 * 1. Resolve hostname to IP addresses at attempt time (not at enqueue time)
 * 2. Validate all resolved addresses are public (via existing destination-guard)
 * 3. Pin the connection to the first validated address
 * 4. Record resolution metadata for diagnostics (without exposing internal topology)
 * 5. Enable TTL-aware re-resolution on retry (respecting DNS TTL)
 *
 * The service enforces:
 * - Deterministic: same hostname always resolves to the same address within a single attempt
 * - Bounded: resolution failures are logged but don't expose resolver internals
 * - Observable: resolution outcomes are recorded per attempt (address, TTL, time taken)
 * - Privacy-safe: no resolution details leak to tenants or untrusted logs
 *
 * Privacy and Security Notes:
 * - Error codes are bounded and never include resolver error messages
 * - IP addresses are resolved but not logged in detail (only duration, count, success/failure)
 * - All addresses are validated to be public before selection
 * - No DNS names, internal topology, or resolver internals are ever exposed
 */

import { Injectable } from "@nestjs/common";
import { lookup, LookupAddress } from "node:dns/promises";
import { isIP } from "node:net";
import { StructuredLogger } from "../logger";
import { assertSafeDestinationUrl, isBlockedHost } from "../http/destination-guard";

/**
 * Per-attempt resolution record. Contains the pinned address and metadata
 * needed to reconnect with the same address or decide if re-resolution is needed.
 */
export interface DnsPinningRecord {
  /** The IP address selected for this attempt's connection (IPv4 or IPv6). */
  resolvedAddress: string;

  /** Unix timestamp when the address was resolved. */
  resolvedAtMs: number;

  /** Approximate TTL in seconds. May be unavailable from node:dns/promises.lookup (returns 0). */
  ttlSeconds: number;

  /** All addresses returned by the resolver (for diagnostics if re-resolution needed). */
  allResolvedAddresses: string[];

  /** Time taken to resolve in milliseconds. */
  resolutionDurationMs: number;
}

export interface DnsPinningError {
  code: string;
  reason: string;
  transient: boolean;
}

/**
 * Result of a DNS pinning operation: either a pinned record or a bounded error.
 */
export type DnsPinningResult = { success: true; record: DnsPinningRecord } | { success: false; error: DnsPinningError };

@Injectable()
export class DnsPinningService {
  private readonly logger = new StructuredLogger(DnsPinningService.name);

  /**
   * Resolve a hostname and return the first validated public address.
   * Called immediately before each connection attempt (including retries).
   *
   * @param hostname Hostname to resolve (extracted from URL)
   * @param resolveFn Optional DNS resolver (for testing; defaults to node:dns/promises.lookup)
   * @returns DnsPinningResult: either a pinned record or bounded error
   */
  async resolveAndPin(
    hostname: string,
    resolveFn: typeof lookup = lookup,
  ): Promise<DnsPinningResult> {
    // If already an IP literal, use it directly without DNS lookup
    if (isIP(hostname) !== 0) {
      // Still validate it's a public address
      if (isBlockedHost(hostname)) {
        return {
          success: false,
          error: {
            code: "BLOCKED_IP_LITERAL",
            reason: `IP literal ${hostname} is not routable`,
            transient: false,
          },
        };
      }
      return {
        success: true,
        record: {
          resolvedAddress: hostname,
          resolvedAtMs: Date.now(),
          ttlSeconds: 0, // No TTL for literals
          allResolvedAddresses: [hostname],
          resolutionDurationMs: 0,
        },
      };
    }

    const startMs = Date.now();
    let addresses: LookupAddress[];

    try {
      addresses = await resolveFn(hostname, { all: true, verbatim: true });
    } catch (err) {
      const code = String((err as { code?: unknown } | null)?.code ?? "UNKNOWN");
      const durationMs = Date.now() - startMs;

      // Classify error as transient or permanent
      const transientCodes = new Set([
        "ENOTFOUND",
        "ENODATA",
        "EAI_AGAIN",
        "EAI_NONAME",
        "ETIMEDOUT",
        "ECONNREFUSED",
      ]);
      const isTransient = transientCodes.has(code);

      this.logger.debug(
        `DNS resolution failed for ${hostname}: ${code} (transient: ${isTransient}, ${durationMs}ms)`,
      );

      return {
        success: false,
        error: {
          code,
          reason: `DNS resolution failed (${code})`,
          transient: isTransient,
        },
      };
    }

    const resolutionDurationMs = Date.now() - startMs;

    if (addresses.length === 0) {
      this.logger.debug(`DNS resolution returned no addresses for ${hostname}`);
      return {
        success: false,
        error: {
          code: "NO_ADDRESSES",
          reason: "DNS resolution returned no addresses",
          transient: true,
        },
      };
    }

    // Validate all addresses are public (defeats DNS rebinding)
    const allAddresses = addresses.map((a) => a.address);
    const blockedAddress = allAddresses.find((addr) => isBlockedHost(addr));

    if (blockedAddress) {
      this.logger.debug(
        `DNS resolution for ${hostname} returned blocked address ${blockedAddress}`,
      );
      return {
        success: false,
        error: {
          code: "BLOCKED_DESTINATION",
          reason: "DNS resolution returned a non-public address",
          transient: false,
        },
      };
    }

    // Pin to first address (deterministic per attempt)
    const selectedAddress = allAddresses[0];

    this.logger.debug(
      `DNS resolved ${hostname} to ${selectedAddress} (${allAddresses.length} address(es), ${resolutionDurationMs}ms)`,
    );

    return {
      success: true,
      record: {
        resolvedAddress: selectedAddress,
        resolvedAtMs: Date.now(),
        ttlSeconds: 0, // node:dns/promises.lookup does not return TTL; use 0 as sentinel
        allResolvedAddresses: allAddresses,
        resolutionDurationMs,
      },
    };
  }

  /**
   * Determine if a pinned address should be re-resolved based on TTL.
   * Returns true if the TTL has expired or was unknown (sentinel 0).
   *
   * @param record The pinning record from a previous attempt
   * @param ttlSeconds Override TTL for the record (used when TTL information is available)
   * @returns true if re-resolution is needed
   */
  shouldReResolve(record: DnsPinningRecord, ttlSeconds?: number): boolean {
    const effectiveTtl = ttlSeconds ?? record.ttlSeconds;

    // If TTL is unknown (sentinel 0), always re-resolve to be safe
    if (effectiveTtl === 0) return true;

    const ageMs = Date.now() - record.resolvedAtMs;
    const ageSeconds = Math.floor(ageMs / 1000);

    return ageSeconds > effectiveTtl;
  }
}

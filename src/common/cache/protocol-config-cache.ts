import { Injectable, Optional } from "@nestjs/common";

/**
 * Cache for protocol-level configuration: schema definitions, supported
 * assets, and contract policy.
 *
 * This data is governed on-chain, so a cached copy can be stale after a
 * governance change. The cache is therefore invalidated by ledger events, with
 * a TTL as the fallback for events that were missed, and it refuses to guess
 * when it cannot establish freshness.
 *
 * Keys are protocol identifiers (`asset:USDC:GA...ISSUER`, `schema:income@2`),
 * never tenant, user, or organization identifiers. Statistics are keyed by
 * namespace and outcome only, so nothing tenant-sensitive can reach a metric.
 */

export type ProtocolConfigNamespace = "schema" | "asset" | "contract-policy";

export interface CacheKey {
  readonly namespace: ProtocolConfigNamespace;
  /** Protocol identifier, e.g. an asset code/issuer pair or schema id. */
  readonly id: string;
}

/** Position of a governance event in the ledger's total order. */
export interface EventPosition {
  readonly ledger: number;
  /** Order of the event within the ledger. */
  readonly index: number;
}

export interface GovernanceEvent {
  readonly namespace: ProtocolConfigNamespace;
  /** Affected entry. Omit to invalidate the whole namespace. */
  readonly id?: string;
  readonly position: EventPosition;
}

export type ConfigFreshness = "fresh" | "stale";

export interface ConfigReadOptions {
  /**
   * Set for any read that feeds an authorization decision. Such a read never
   * serves stale data and never serves data whose freshness is unknown: if a
   * fresh value cannot be loaded, it throws.
   */
  readonly authorizationSensitive: boolean;
}

export interface ConfigReadResult<T> {
  readonly value: T;
  readonly freshness: ConfigFreshness;
}

export interface ProtocolConfigCacheOptions {
  readonly ttlMs: number;
  /** How long past TTL a non-sensitive read may fall back to a stale value. */
  readonly staleGraceMs: number;
  readonly maxEntries: number;
  readonly now: () => number;
}

export const DEFAULT_PROTOCOL_CONFIG_CACHE_OPTIONS: ProtocolConfigCacheOptions =
  {
    ttlMs: 60_000,
    staleGraceMs: 5 * 60_000,
    maxEntries: 1_000,
    now: () => Date.now(),
  };

/**
 * Thrown when an authorization-sensitive read cannot be served with
 * verified-fresh data. Callers must treat it as a denial, not as "use the
 * default".
 */
export class ProtocolConfigUnavailableError extends Error {
  readonly code = "PROTOCOL_CONFIG_UNAVAILABLE";
  constructor(readonly namespace: ProtocolConfigNamespace) {
    // Names the namespace only; the key may identify a specific asset or
    // contract and does not belong in an error message.
    super(`Protocol configuration (${namespace}) is unavailable`);
    this.name = "ProtocolConfigUnavailableError";
  }
}

export type CacheOutcome =
  | "hit"
  | "miss"
  | "stale_served"
  | "refresh_failed"
  | "invalidated"
  | "event_ignored"
  | "unverified_bypass";

export type CacheStats = Record<
  ProtocolConfigNamespace,
  Record<CacheOutcome, number>
>;

interface Entry {
  value: unknown;
  loadedAt: number;
  expiresAt: number;
}

function compare(a: EventPosition, b: EventPosition): number {
  return a.ledger !== b.ledger ? a.ledger - b.ledger : a.index - b.index;
}

function emptyStats(): CacheStats {
  const outcomes = (): Record<CacheOutcome, number> => ({
    hit: 0,
    miss: 0,
    stale_served: 0,
    refresh_failed: 0,
    invalidated: 0,
    event_ignored: 0,
    unverified_bypass: 0,
  });
  return {
    schema: outcomes(),
    asset: outcomes(),
    "contract-policy": outcomes(),
  };
}

const NAMESPACES: readonly ProtocolConfigNamespace[] = [
  "schema",
  "asset",
  "contract-policy",
];

@Injectable()
export class ProtocolConfigCache {
  private readonly options: ProtocolConfigCacheOptions;
  private readonly entries = new Map<string, Entry>();
  /** Bumped on every invalidation; a load that straddles one is not stored. */
  private readonly generations = new Map<string, number>();
  /** Highest event position applied per key, so reordered events are ignored. */
  private readonly appliedEvents = new Map<string, EventPosition>();
  /** Highest namespace-wide event applied per namespace. */
  private readonly appliedNamespaceEvents = new Map<
    ProtocolConfigNamespace,
    EventPosition
  >();
  /** Bumped on namespace-wide invalidation, covering keys not yet loaded. */
  private readonly namespaceGenerations = new Map<
    ProtocolConfigNamespace,
    number
  >();
  private readonly stats = emptyStats();
  /**
   * When set, the event stream may have missed events since this instant, so
   * nothing loaded earlier can be proven current.
   */
  private freshnessUnknownSince: number | null = null;

  constructor(@Optional() options: Partial<ProtocolConfigCacheOptions> = {}) {
    this.options = { ...DEFAULT_PROTOCOL_CONFIG_CACHE_OPTIONS, ...options };
  }

  /**
   * Reads a value, loading it on a miss.
   *
   * @throws ProtocolConfigUnavailableError when `authorizationSensitive` and a
   *   verified-fresh value could not be obtained, or when no value (not even a
   *   permitted stale one) is available for a non-sensitive read.
   */
  async read<T>(
    key: CacheKey,
    load: () => Promise<T>,
    options: ConfigReadOptions,
  ): Promise<ConfigReadResult<T>> {
    const cacheKey = this.keyOf(key);
    const now = this.options.now();
    const entry = this.entries.get(cacheKey);

    if (entry && now < entry.expiresAt) {
      if (this.isVerified(entry)) {
        this.count(key.namespace, "hit");
        return { value: entry.value as T, freshness: "fresh" };
      }
      // Within TTL but loaded before the event stream became unreliable.
      this.count(key.namespace, "unverified_bypass");
    } else {
      this.count(key.namespace, "miss");
    }

    const generation = this.generationOf(key.namespace, cacheKey);
    try {
      const value = await load();
      this.store(key.namespace, cacheKey, value, generation);
      return { value, freshness: "fresh" };
    } catch {
      this.count(key.namespace, "refresh_failed");
      // The loader's error is deliberately not propagated or logged here: it
      // can carry the raw response it failed on.
      if (
        !options.authorizationSensitive &&
        entry &&
        this.isVerified(entry) &&
        now < entry.expiresAt + this.options.staleGraceMs
      ) {
        this.count(key.namespace, "stale_served");
        return { value: entry.value as T, freshness: "stale" };
      }
      throw new ProtocolConfigUnavailableError(key.namespace);
    }
  }

  /**
   * Applies a governance event. Returns `false` when the event is a duplicate
   * or arrived out of order behind one already applied, in which case nothing
   * changes.
   */
  applyGovernanceEvent(event: GovernanceEvent): boolean {
    const { namespace, id, position } = event;

    const namespaceApplied = this.appliedNamespaceEvents.get(namespace);
    if (!id) {
      if (namespaceApplied && compare(position, namespaceApplied) <= 0) {
        this.count(namespace, "event_ignored");
        return false;
      }
      this.appliedNamespaceEvents.set(namespace, position);
      for (const cacheKey of [...this.entries.keys()]) {
        if (cacheKey.startsWith(`${namespace}:`)) this.invalidateKey(cacheKey);
      }
      // A load in flight for any key in this namespace must not be stored.
      this.namespaceGenerations.set(
        namespace,
        (this.namespaceGenerations.get(namespace) ?? 0) + 1,
      );
      this.count(namespace, "invalidated");
      return true;
    }

    const cacheKey = this.keyOf({ namespace, id });
    const applied = this.appliedEvents.get(cacheKey);
    if (applied && compare(position, applied) <= 0) {
      this.count(namespace, "event_ignored");
      return false;
    }
    this.appliedEvents.set(cacheKey, position);
    this.invalidateKey(cacheKey);
    this.bump(cacheKey);
    this.count(namespace, "invalidated");
    return true;
  }

  /**
   * Records that the event stream may have skipped events (cursor loss, outage,
   * detected gap). Until entries are reloaded, authorization-sensitive reads
   * will not trust anything loaded before this point.
   */
  markFreshnessUnknown(): void {
    this.freshnessUnknownSince = this.options.now();
  }

  /**
   * Records that the event stream is known to be complete again, for example
   * after a backfill closed the gap. Entries loaded before the gap are trusted
   * again only if still within TTL.
   */
  markFreshnessRestored(): void {
    this.freshnessUnknownSince = null;
  }

  get freshnessUnknown(): boolean {
    return this.freshnessUnknownSince !== null;
  }

  /** Counters by namespace and outcome. Contains no keys or tenant data. */
  snapshotStats(): CacheStats {
    const copy = emptyStats();
    for (const ns of NAMESPACES) Object.assign(copy[ns], this.stats[ns]);
    return copy;
  }

  get size(): number {
    return this.entries.size;
  }

  private isVerified(entry: Entry): boolean {
    return (
      this.freshnessUnknownSince === null ||
      entry.loadedAt >= this.freshnessUnknownSince
    );
  }

  private generationOf(
    namespace: ProtocolConfigNamespace,
    cacheKey: string,
  ): string {
    return `${this.namespaceGenerations.get(namespace) ?? 0}.${this.generations.get(cacheKey) ?? 0}`;
  }

  private store(
    namespace: ProtocolConfigNamespace,
    cacheKey: string,
    value: unknown,
    generation: string,
  ): void {
    // An invalidation landed while loading: the value may predate it.
    if (this.generationOf(namespace, cacheKey) !== generation) return;

    if (
      !this.entries.has(cacheKey) &&
      this.entries.size >= this.options.maxEntries
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const now = this.options.now();
    this.entries.set(cacheKey, {
      value,
      loadedAt: now,
      expiresAt: now + this.options.ttlMs,
    });
  }

  private invalidateKey(cacheKey: string): void {
    this.entries.delete(cacheKey);
  }

  private bump(cacheKey: string): void {
    this.generations.set(cacheKey, (this.generations.get(cacheKey) ?? 0) + 1);
  }

  private keyOf(key: CacheKey): string {
    return `${key.namespace}:${key.id}`;
  }

  private count(namespace: ProtocolConfigNamespace, outcome: CacheOutcome) {
    this.stats[namespace][outcome] += 1;
  }
}

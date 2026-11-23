import {
  ProtocolConfigCache,
  ProtocolConfigUnavailableError,
  type CacheKey,
} from "./protocol-config-cache";

const ASSET: CacheKey = { namespace: "asset", id: "USDC:GISSUER" };
const SCHEMA: CacheKey = { namespace: "schema", id: "income@2" };
const SENSITIVE = { authorizationSensitive: true } as const;
const TOLERANT = { authorizationSensitive: false } as const;

function setup(overrides: { ttlMs?: number; staleGraceMs?: number; maxEntries?: number } = {}) {
  let clock = 1_000_000;
  const cache = new ProtocolConfigCache({
    ttlMs: 1_000,
    staleGraceMs: 5_000,
    now: () => clock,
    ...overrides,
  });
  return {
    cache,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("ProtocolConfigCache", () => {
  describe("caching", () => {
    it("loads once and serves later reads from cache within the TTL", async () => {
      const { cache } = setup();
      const load = jest.fn().mockResolvedValue({ enabled: true });

      await cache.read(ASSET, load, SENSITIVE);
      const second = await cache.read(ASSET, load, SENSITIVE);

      expect(load).toHaveBeenCalledTimes(1);
      expect(second).toEqual({ value: { enabled: true }, freshness: "fresh" });
    });

    it("reloads after the TTL elapses (fallback when events are missed)", async () => {
      const { cache, advance } = setup();
      const load = jest.fn().mockResolvedValueOnce("v1").mockResolvedValueOnce("v2");

      await cache.read(ASSET, load, SENSITIVE);
      advance(1_001);
      const result = await cache.read(ASSET, load, SENSITIVE);

      expect(result.value).toBe("v2");
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("keeps namespaces separate for the same id", async () => {
      const { cache } = setup();
      await cache.read({ namespace: "asset", id: "x" }, async () => "a", SENSITIVE);
      const other = await cache.read(
        { namespace: "schema", id: "x" },
        async () => "s",
        SENSITIVE,
      );
      expect(other.value).toBe("s");
    });

    it("evicts the oldest entry beyond maxEntries", async () => {
      const { cache } = setup({ maxEntries: 2 });
      for (const id of ["a", "b", "c"]) {
        await cache.read({ namespace: "asset", id }, async () => id, SENSITIVE);
      }
      expect(cache.size).toBe(2);
    });
  });

  describe("governance event invalidation", () => {
    it("invalidates the affected entry so the next read reloads", async () => {
      const { cache } = setup();
      const load = jest.fn().mockResolvedValueOnce("old").mockResolvedValueOnce("new");
      await cache.read(ASSET, load, SENSITIVE);

      const applied = cache.applyGovernanceEvent({
        namespace: "asset",
        id: ASSET.id,
        position: { ledger: 10, index: 0 },
      });
      const result = await cache.read(ASSET, load, SENSITIVE);

      expect(applied).toBe(true);
      expect(result.value).toBe("new");
    });

    it("leaves unrelated entries cached", async () => {
      const { cache } = setup();
      const load = jest.fn().mockResolvedValue("schema");
      await cache.read(SCHEMA, load, SENSITIVE);

      cache.applyGovernanceEvent({
        namespace: "asset",
        id: ASSET.id,
        position: { ledger: 10, index: 0 },
      });
      await cache.read(SCHEMA, load, SENSITIVE);

      expect(load).toHaveBeenCalledTimes(1);
    });

    it("invalidates a whole namespace when the event names no id", async () => {
      const { cache } = setup();
      const loadA = jest.fn().mockResolvedValue("a");
      const loadB = jest.fn().mockResolvedValue("b");
      await cache.read({ namespace: "asset", id: "A" }, loadA, SENSITIVE);
      await cache.read({ namespace: "asset", id: "B" }, loadB, SENSITIVE);

      cache.applyGovernanceEvent({ namespace: "asset", position: { ledger: 5, index: 0 } });
      await cache.read({ namespace: "asset", id: "A" }, loadA, SENSITIVE);
      await cache.read({ namespace: "asset", id: "B" }, loadB, SENSITIVE);

      expect(loadA).toHaveBeenCalledTimes(2);
      expect(loadB).toHaveBeenCalledTimes(2);
    });

    it("does not store a value whose load straddled an invalidation", async () => {
      const { cache } = setup();
      let release!: (value: string) => void;
      const slow = new Promise<string>((resolve) => (release = resolve));
      const pending = cache.read(ASSET, () => slow, SENSITIVE);

      cache.applyGovernanceEvent({
        namespace: "asset",
        id: ASSET.id,
        position: { ledger: 10, index: 0 },
      });
      release("predates-event");
      await pending;

      expect(cache.size).toBe(0);
    });

    it("does not store a value whose load straddled a namespace-wide invalidation", async () => {
      const { cache } = setup();
      let release!: (value: string) => void;
      const pending = cache.read(
        ASSET,
        () => new Promise<string>((resolve) => (release = resolve)),
        SENSITIVE,
      );

      cache.applyGovernanceEvent({ namespace: "asset", position: { ledger: 10, index: 0 } });
      release("predates-event");
      await pending;

      expect(cache.size).toBe(0);
    });
  });

  describe("event reordering and duplicates", () => {
    it("ignores an event older than one already applied", () => {
      const { cache } = setup();
      const newer = { namespace: "asset" as const, id: ASSET.id, position: { ledger: 20, index: 0 } };
      const older = { namespace: "asset" as const, id: ASSET.id, position: { ledger: 19, index: 5 } };

      expect(cache.applyGovernanceEvent(newer)).toBe(true);
      expect(cache.applyGovernanceEvent(older)).toBe(false);
      expect(cache.snapshotStats().asset.event_ignored).toBe(1);
    });

    it("ignores an exact duplicate", () => {
      const { cache } = setup();
      const event = { namespace: "asset" as const, id: ASSET.id, position: { ledger: 3, index: 1 } };

      expect(cache.applyGovernanceEvent(event)).toBe(true);
      expect(cache.applyGovernanceEvent(event)).toBe(false);
    });

    it("orders by index within the same ledger", () => {
      const { cache } = setup();
      const at = (index: number) => ({
        namespace: "asset" as const,
        id: ASSET.id,
        position: { ledger: 7, index },
      });

      expect(cache.applyGovernanceEvent(at(2))).toBe(true);
      expect(cache.applyGovernanceEvent(at(1))).toBe(false);
      expect(cache.applyGovernanceEvent(at(3))).toBe(true);
    });

    it("an ignored reordered event does not drop a value loaded after the newer one", async () => {
      const { cache } = setup();
      const load = jest.fn().mockResolvedValue("post-update");
      cache.applyGovernanceEvent({ namespace: "asset", id: ASSET.id, position: { ledger: 20, index: 0 } });
      await cache.read(ASSET, load, SENSITIVE);

      cache.applyGovernanceEvent({ namespace: "asset", id: ASSET.id, position: { ledger: 19, index: 0 } });
      await cache.read(ASSET, load, SENSITIVE);

      expect(load).toHaveBeenCalledTimes(1);
    });
  });

  describe("refresh failure", () => {
    it("fails closed for an authorization-sensitive read, even with a stale entry", async () => {
      const { cache, advance } = setup();
      await cache.read(ASSET, async () => "cached", SENSITIVE);
      advance(1_500);

      await expect(
        cache.read(ASSET, async () => Promise.reject(new Error("rpc down")), SENSITIVE),
      ).rejects.toBeInstanceOf(ProtocolConfigUnavailableError);
    });

    it("serves a stale value to a tolerant read within the grace window", async () => {
      const { cache, advance } = setup();
      await cache.read(ASSET, async () => "cached", TOLERANT);
      advance(1_500);

      const result = await cache.read(
        ASSET,
        async () => Promise.reject(new Error("rpc down")),
        TOLERANT,
      );

      expect(result).toEqual({ value: "cached", freshness: "stale" });
    });

    it("refuses a tolerant read once the grace window has passed", async () => {
      const { cache, advance } = setup();
      await cache.read(ASSET, async () => "cached", TOLERANT);
      advance(1_000 + 5_000);

      await expect(
        cache.read(ASSET, async () => Promise.reject(new Error("down")), TOLERANT),
      ).rejects.toBeInstanceOf(ProtocolConfigUnavailableError);
    });

    it("fails closed when there is no cached value at all", async () => {
      const { cache } = setup();
      await expect(
        cache.read(ASSET, async () => Promise.reject(new Error("down")), TOLERANT),
      ).rejects.toBeInstanceOf(ProtocolConfigUnavailableError);
    });

    it("does not carry the loader's error text into the thrown error", async () => {
      const { cache } = setup();
      const error = await cache
        .read(ASSET, async () => Promise.reject(new Error("raw-rpc-payload")), SENSITIVE)
        .catch((e: Error) => e);

      expect((error as Error).message).not.toContain("raw-rpc-payload");
      expect((error as Error).message).not.toContain(ASSET.id);
    });
  });

  describe("unknown freshness (missed events)", () => {
    it("does not trust an in-TTL entry loaded before the stream became unreliable", async () => {
      const { cache, advance } = setup();
      const load = jest.fn().mockResolvedValueOnce("old").mockResolvedValueOnce("new");
      await cache.read(ASSET, load, SENSITIVE);
      advance(10);
      cache.markFreshnessUnknown();

      const result = await cache.read(ASSET, load, SENSITIVE);

      expect(result.value).toBe("new");
    });

    it("fails closed when freshness is unknown and the refresh fails", async () => {
      const { cache, advance } = setup();
      await cache.read(ASSET, async () => "old", SENSITIVE);
      advance(10);
      cache.markFreshnessUnknown();

      await expect(
        cache.read(ASSET, async () => Promise.reject(new Error("down")), SENSITIVE),
      ).rejects.toBeInstanceOf(ProtocolConfigUnavailableError);
    });

    it("does not serve an unverified entry as stale to a tolerant read", async () => {
      const { cache, advance } = setup();
      await cache.read(ASSET, async () => "old", TOLERANT);
      advance(10);
      cache.markFreshnessUnknown();

      await expect(
        cache.read(ASSET, async () => Promise.reject(new Error("down")), TOLERANT),
      ).rejects.toBeInstanceOf(ProtocolConfigUnavailableError);
    });

    it("trusts values loaded after the gap was recorded", async () => {
      const { cache, advance } = setup();
      cache.markFreshnessUnknown();
      advance(1);
      const load = jest.fn().mockResolvedValue("fresh");
      await cache.read(ASSET, load, SENSITIVE);
      await cache.read(ASSET, load, SENSITIVE);

      expect(load).toHaveBeenCalledTimes(1);
    });

    it("trusts in-TTL entries again once freshness is restored", async () => {
      const { cache, advance } = setup();
      const load = jest.fn().mockResolvedValue("v");
      await cache.read(ASSET, load, SENSITIVE);
      advance(10);
      cache.markFreshnessUnknown();
      cache.markFreshnessRestored();
      await cache.read(ASSET, load, SENSITIVE);

      expect(cache.freshnessUnknown).toBe(false);
      expect(load).toHaveBeenCalledTimes(1);
    });
  });

  describe("metrics", () => {
    it("counts outcomes by namespace and exposes no keys or tenant values", async () => {
      const { cache } = setup();
      await cache.read(ASSET, async () => "v", SENSITIVE);
      await cache.read(ASSET, async () => "v", SENSITIVE);

      const stats = cache.snapshotStats();

      expect(stats.asset.miss).toBe(1);
      expect(stats.asset.hit).toBe(1);
      const serialised = JSON.stringify(stats);
      expect(serialised).not.toContain(ASSET.id);
      expect(Object.keys(stats).sort()).toEqual(["asset", "contract-policy", "schema"]);
    });

    it("returns a copy that callers cannot use to mutate the counters", async () => {
      const { cache } = setup();
      cache.snapshotStats().asset.hit = 999;
      expect(cache.snapshotStats().asset.hit).toBe(0);
    });
  });
});

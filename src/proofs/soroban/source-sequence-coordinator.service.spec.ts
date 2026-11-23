import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { SourceSequenceCoordinator } from "./source-sequence-coordinator.service";

type Row = {
  accountKey: string;
  holderToken: string;
  holderId: string;
  fencingCounter: number;
  expiresAt: Date;
};

/**
 * In-memory stand-in for the lease table with the same atomicity the real one
 * has: `create` enforces the unique key, and `updateMany` evaluates its
 * predicate and applies its write in one step. Each operation yields to the
 * event loop first, so concurrent callers genuinely interleave.
 */
function fakePrisma() {
  const rows = new Map<string, Row>();
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  const lease = {
    async create({ data }: { data: Omit<Row, "fencingCounter"> }) {
      await tick();
      if (rows.has(data.accountKey)) {
        throw new Prisma.PrismaClientKnownRequestError("unique", {
          code: "P2002",
          clientVersion: "test",
        });
      }
      const row = { ...data, fencingCounter: 1 };
      rows.set(row.accountKey, row);
      return { ...row };
    },
    async updateMany({
      where,
      data,
    }: {
      where: {
        accountKey: string;
        holderToken?: string;
        expiresAt: { lt?: Date; gte?: Date };
      };
      data: Partial<Row> & { fencingCounter?: { increment: number } };
    }) {
      await tick();
      const row = rows.get(where.accountKey);
      if (!row) return { count: 0 };
      if (where.holderToken && row.holderToken !== where.holderToken) {
        return { count: 0 };
      }
      if (where.expiresAt.lt && !(row.expiresAt < where.expiresAt.lt)) {
        return { count: 0 };
      }
      if (where.expiresAt.gte && !(row.expiresAt >= where.expiresAt.gte)) {
        return { count: 0 };
      }
      const { fencingCounter, ...rest } = data;
      Object.assign(row, rest);
      if (fencingCounter) row.fencingCounter += fencingCounter.increment;
      return { count: 1 };
    },
    async findUnique({ where }: { where: { accountKey: string } }) {
      await tick();
      const row = rows.get(where.accountKey);
      return row ? { ...row } : null;
    },
    async deleteMany({
      where,
    }: {
      where: { accountKey: string; holderToken: string };
    }) {
      await tick();
      const row = rows.get(where.accountKey);
      if (row && row.holderToken === where.holderToken) {
        rows.delete(where.accountKey);
        return { count: 1 };
      }
      return { count: 0 };
    },
  };

  return {
    rows,
    prisma: { sourceAccountSequenceLease: lease } as unknown as PrismaService,
  };
}

const TTL_MS = 1_000;
const SOURCE = "SABCDEFSECRETSOURCEKEYMUSTNEVERBESTORED";

function build() {
  const { prisma, rows } = fakePrisma();
  const config = {
    get: (key: string) =>
      key === "contractAnchoring.sequenceLease.ttlMs" ? TTL_MS : undefined,
  } as unknown as ConfigService;
  return { coordinator: new SourceSequenceCoordinator(prisma, config), rows };
}

describe("SourceSequenceCoordinator", () => {
  beforeEach(() => {
    // Fake only Date so lease expiry is controllable; leave timers and
    // microtasks real so the interleaving above still runs.
    jest.useFakeTimers({
      now: new Date("2026-12-01T00:00:00Z"),
      doNotFake: [
        "nextTick",
        "setImmediate",
        "clearImmediate",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "queueMicrotask",
        "performance",
      ],
    });
  });
  afterEach(() => jest.useRealTimers());

  const advance = (ms: number) =>
    jest.setSystemTime(new Date(Date.now() + ms));

  describe("exclusivity", () => {
    it("lets exactly one of many concurrent workers acquire an account", async () => {
      const { coordinator } = build();

      const results = await Promise.all(
        Array.from({ length: 12 }, () => coordinator.acquire(SOURCE)),
      );

      expect(results.filter((lease) => lease !== null)).toHaveLength(1);
    });

    it("does not make workers on different accounts wait for each other", async () => {
      const { coordinator } = build();

      const [a, b] = await Promise.all([
        coordinator.acquire("source-a"),
        coordinator.acquire("source-b"),
      ]);

      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
    });

    it("refuses a second acquisition by the same process while held", async () => {
      const { coordinator } = build();

      const first = await coordinator.acquire(SOURCE);
      const second = await coordinator.acquire(SOURCE);

      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });

    it("lets the next worker in after a release", async () => {
      const { coordinator } = build();

      const first = (await coordinator.acquire(SOURCE))!;
      await coordinator.release(first);

      expect(await coordinator.acquire(SOURCE)).not.toBeNull();
    });

    it("only releases the lease its own token holds", async () => {
      const { coordinator } = build();
      const held = (await coordinator.acquire(SOURCE))!;

      await coordinator.release({ ...held, token: "someone-else" });

      expect(await coordinator.acquire(SOURCE)).toBeNull();
    });
  });

  describe("multi-worker ordering", () => {
    it("never runs two critical sections for one account at once, and hands out distinct, ordered sequences", async () => {
      const { coordinator } = build();
      let active = 0;
      let maxActive = 0;
      let nextSequence = 100;
      const observed: number[] = [];

      const worker = async () => {
        for (;;) {
          const outcome = await coordinator.withLease(SOURCE, async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            // Read-modify-write on a shared "sequence" with a yield in the
            // middle: without exclusion two workers would read the same value.
            const sequence = nextSequence;
            await new Promise((resolve) => setImmediate(resolve));
            nextSequence = sequence + 1;
            observed.push(sequence);
            active -= 1;
          });
          if (outcome.acquired) return;
          await new Promise((resolve) => setImmediate(resolve));
        }
      };

      await Promise.all(Array.from({ length: 8 }, worker));

      expect(maxActive).toBe(1);
      expect(observed).toHaveLength(8);
      expect(new Set(observed).size).toBe(8);
      expect(observed).toEqual([...observed].sort((x, y) => x - y));
      expect(observed[0]).toBe(100);
      expect(observed.at(-1)).toBe(107);
    });

    it("releases the lease when the critical section throws", async () => {
      const { coordinator } = build();

      await expect(
        coordinator.withLease(SOURCE, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(await coordinator.acquire(SOURCE)).not.toBeNull();
    });

    it("reports not-acquired instead of running when the account is held", async () => {
      const { coordinator } = build();
      await coordinator.acquire(SOURCE);
      const fn = jest.fn();

      const outcome = await coordinator.withLease(SOURCE, fn);

      expect(outcome).toEqual({ acquired: false });
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe("stale-allocation recovery", () => {
    it("does not take over a lease one millisecond before it expires", async () => {
      const { coordinator } = build();
      await coordinator.acquire(SOURCE);

      advance(TTL_MS - 1);

      expect(await coordinator.acquire(SOURCE)).toBeNull();
    });

    it("recovers an abandoned lease once it has expired and bumps the fencing counter", async () => {
      const { coordinator } = build();
      const abandoned = (await coordinator.acquire(SOURCE))!;

      advance(TTL_MS + 1);
      const recovered = await coordinator.acquire(SOURCE);

      expect(recovered).not.toBeNull();
      expect(recovered!.fencingCounter).toBe(abandoned.fencingCounter + 1);
      expect(recovered!.token).not.toBe(abandoned.token);
    });

    it("lets exactly one of many racing workers recover an expired lease", async () => {
      const { coordinator } = build();
      await coordinator.acquire(SOURCE);
      advance(TTL_MS + 1);

      const results = await Promise.all(
        Array.from({ length: 10 }, () => coordinator.acquire(SOURCE)),
      );

      expect(results.filter((lease) => lease !== null)).toHaveLength(1);
    });

    it("tells a stalled holder it lost the lease, so it cannot submit", async () => {
      const { coordinator } = build();
      const stalled = (await coordinator.acquire(SOURCE))!;
      advance(TTL_MS + 1);
      await coordinator.acquire(SOURCE);

      expect(await coordinator.renew(stalled)).toBe(false);
    });

    it("refuses to renew an expired lease even if nobody took it over", async () => {
      const { coordinator } = build();
      const lease = (await coordinator.acquire(SOURCE))!;

      advance(TTL_MS + 1);

      expect(await coordinator.renew(lease)).toBe(false);
    });

    it("extends a live lease on renewal", async () => {
      const { coordinator } = build();
      const lease = (await coordinator.acquire(SOURCE))!;

      advance(TTL_MS - 100);
      expect(await coordinator.renew(lease)).toBe(true);
      advance(TTL_MS - 100);

      // Past the original expiry, inside the renewed one.
      expect(await coordinator.acquire(SOURCE)).toBeNull();
    });
  });

  describe("privacy and failure handling", () => {
    it("stores a hash of the source, never the source itself", async () => {
      const { coordinator, rows } = build();
      await coordinator.acquire(SOURCE);

      const [row] = [...rows.values()];
      expect(JSON.stringify(row)).not.toContain(SOURCE);
      expect(row.accountKey).toMatch(/^[a-f0-9]{64}$/);
      expect(row.accountKey).toBe(SourceSequenceCoordinator.accountKeyFor(SOURCE));
    });

    it("rethrows unexpected database errors rather than reporting 'busy'", async () => {
      const { prisma } = fakePrisma();
      (prisma.sourceAccountSequenceLease as unknown as { create: jest.Mock }).create =
        jest.fn().mockRejectedValue(new Error("connection reset"));
      const coordinator = new SourceSequenceCoordinator(prisma, {
        get: () => undefined,
      } as unknown as ConfigService);

      await expect(coordinator.acquire(SOURCE)).rejects.toThrow("connection reset");
    });

    it("swallows a failed release, since the lease expires on its own", async () => {
      const { prisma } = fakePrisma();
      const coordinator = new SourceSequenceCoordinator(prisma, {
        get: () => undefined,
      } as unknown as ConfigService);
      const lease = (await coordinator.acquire(SOURCE))!;
      (
        prisma.sourceAccountSequenceLease as unknown as { deleteMany: jest.Mock }
      ).deleteMany = jest.fn().mockRejectedValue(new Error("db down"));

      await expect(coordinator.release(lease)).resolves.toBeUndefined();
    });
  });
});

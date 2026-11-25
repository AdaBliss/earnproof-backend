import { ResourceStatus } from "@prisma/client";
import { ApiKeyService } from "../../api-keys/api-key.service";
import { IssuersService } from "../../issuers/issuers.service";
import { OrganizationsService } from "../../organizations/organizations.service";
import { PaymentsService } from "../../payments/payments.service";
import { ProofsService } from "../../proofs/proofs.service";
import { WebhooksService } from "../../webhooks/webhooks.service";
import {
  QUERY_BUDGETS,
  QueryBudgetName,
  QueryCounter,
  assertWithinBudget,
  countingClient,
} from "./query-budget";

/**
 * Query-count budgets for the list endpoints (docs/query-budgets.md).
 *
 * Each test runs the real service method against a mock Prisma client that
 * honours `take`, the way the database would, so the rows returned grow with the
 * page size. A path whose query count depends on the page size (an N+1) then
 * fails: the count at limit 100 would differ from the count at limit 1.
 */

const PAGE_SIZES = [1, 10, 100] as const;
const NOW = new Date("2026-01-01T00:00:00.000Z");

const rowsOf = <T>(count: number, make: (i: number) => T): T[] =>
  Array.from({ length: Math.max(0, count) }, (_, i) => make(i));

const orgRow = (i: number) => ({
  id: `org_${i}`,
  name: `Org ${i}`,
  slug: `org-${i}`,
  website: null,
  status: ResourceStatus.ACTIVE,
  revision: 1,
  createdById: "user_1",
  createdAt: new Date(NOW.getTime() - i * 1000),
  updatedAt: NOW,
});

const issuerRow = (i: number) => ({
  id: `issuer_${i}`,
  organizationId: "org_0",
  stellarAddress: `G${String(i).padStart(55, "A")}`,
  status: ResourceStatus.ACTIVE,
  verifiedAt: NOW,
  publicMetadata: {},
  createdAt: new Date(NOW.getTime() - i * 1000),
  updatedAt: NOW,
});

const paymentRow = (i: number) => ({
  id: `pay_${i}`,
  network: "testnet",
  operationId: `op_${i}`,
  operationIndex: 0,
  stellarTransactionHash: "h".repeat(64),
  sourceAddress: "GSOURCE",
  sourceAddressEncrypted: null,
  destinationAddress: "GDEST",
  destinationAddressEncrypted: null,
  assetCode: "XLM",
  assetIssuer: null,
  occurredAt: new Date(NOW.getTime() - i * 1000),
  classification: "INCOME",
  classificationRevision: 1,
  isEligible: true,
  finalityHoldAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  memo: null,
});

const proofRow = (i: number) => ({
  id: `proof_${i}`,
  proofType: "MINIMUM_INCOME",
  schemaVersion: "v1",
  status: "ACTIVE",
  assetCode: "XLM",
  assetIssuer: null,
  periodStart: null,
  periodEnd: null,
  createdAt: new Date(NOW.getTime() - i * 1000),
  expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  revokedAt: null,
  contractTransactionHash: null,
});

const apiKeyRow = (i: number) => ({
  id: `key_${i}`,
  prefix: `ep_${i}`,
  name: `key ${i}`,
  status: "ACTIVE",
  scopeAssignments: [{ scope: "proofs:read" }, { scope: "payments:read" }],
  createdAt: new Date(NOW.getTime() - i * 1000),
});

const webhookRow = (i: number) => ({
  id: `wh_${i}`,
  url: `https://hooks.example/${i}`,
  events: ["proof.created"],
  payloadVersion: "1",
  status: "ACTIVE",
  revision: 1,
  createdAt: new Date(NOW.getTime() - i * 1000),
  updatedAt: NOW,
});

const deliveryRow = (i: number) => ({
  id: `del_${i}`,
  eventType: "proof.created",
  eventId: `evt_${i}`,
  attempt: 1,
  status: "SUCCESS",
  createdAt: new Date(NOW.getTime() - i * 1000),
});

/** A findMany that behaves like the database: returns up to `take` rows. */
const findManyOf = (make: (i: number) => unknown, available = 1_000) =>
  jest.fn(async (args?: { take?: number }) =>
    rowsOf(Math.min(args?.take ?? available, available), make),
  );

function mockPrisma() {
  return {
    organization: {
      findMany: findManyOf(orgRow),
      count: jest.fn().mockResolvedValue(1_000),
    },
    issuer: {
      findMany: findManyOf(issuerRow),
      count: jest.fn().mockResolvedValue(1_000),
      groupBy: jest.fn(async (args: { where: { organizationId: { in: string[] } } }) =>
        args.where.organizationId.in.map((organizationId) => ({
          organizationId,
          _count: { _all: 3 },
        })),
      ),
    },
    payment: { findMany: findManyOf(paymentRow) },
    proof: { findMany: findManyOf(proofRow) },
    apiKey: { findMany: findManyOf(apiKeyRow) },
    webhook: {
      findMany: findManyOf(webhookRow),
      findUnique: jest.fn().mockResolvedValue({
        id: "wh_1",
        organizationId: "org_1",
        status: "ACTIVE",
        revision: 1,
      }),
    },
    webhookDelivery: { findMany: findManyOf(deliveryRow) },
  };
}

type Prisma = ReturnType<typeof mockPrisma>;

const ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const config = {
  get: jest.fn(() => undefined),
  getOrThrow: jest.fn((key: string) => {
    if (key === "paymentEncryptionKey") return ENCRYPTION_KEY;
    if (key === "stellar.network") return "testnet";
    throw new Error(`Unexpected config key: ${key}`);
  }),
};

const admin = { id: "admin_1", role: "ADMIN" } as never;
const member = { id: "user_1", role: "USER" } as never;

/** Runs `call` once per page size and returns the operation count of each. */
async function countsAcrossPageSizes(
  build: (prisma: Prisma) => (limit: number) => Promise<unknown>,
): Promise<{ counts: number[]; counters: QueryCounter[]; prisma: Prisma }> {
  const prisma = mockPrisma();
  const counters: QueryCounter[] = [];
  const counts: number[] = [];
  for (const limit of PAGE_SIZES) {
    const counter = new QueryCounter();
    const call = build(countingClient(prisma, counter) as Prisma);
    await call(limit);
    counters.push(counter);
    counts.push(counter.count);
  }
  return { counts, counters, prisma };
}

function expectBudget(name: QueryBudgetName, result: { counts: number[]; counters: QueryCounter[] }) {
  // Pagination size must not cause linear (or any) query growth.
  expect(new Set(result.counts).size).toBe(1);
  for (const counter of result.counters) assertWithinBudget(name, counter);
  expect(result.counts[0]).toBeLessThanOrEqual(QUERY_BUDGETS[name]);
}

describe("list endpoint query budgets", () => {
  describe("organizations.list", () => {
    const build = (prisma: Prisma) => {
      const service = new OrganizationsService(prisma as never, {} as never, {} as never);
      return (limit: number) => service.listOrganizations(admin, { limit });
    };

    it("stays within budget and is independent of page size", async () => {
      expectBudget("organizations.list", await countsAcrossPageSizes(build));
    });

    it("issues one grouped issuer query, never one per organization (N+1 regression)", async () => {
      const { counters } = await countsAcrossPageSizes(build);
      for (const counter of counters) {
        expect(counter.operations.filter((op) => op === "issuer.count")).toHaveLength(0);
        expect(counter.operations.filter((op) => op === "issuer.groupBy")).toHaveLength(1);
      }
    });

    it("still reports the correct issuerCount for every organization", async () => {
      const prisma = mockPrisma();
      prisma.issuer.groupBy = jest.fn(async () => [
        { organizationId: "org_0", _count: { _all: 5 } },
        { organizationId: "org_2", _count: { _all: 1 } },
      ]);
      const service = new OrganizationsService(prisma as never, {} as never, {} as never);

      const result = await service.listOrganizations(admin, { limit: 3 });

      expect(result.items.map((o) => [o.id, o.issuerCount])).toEqual([
        ["org_0", 5],
        ["org_1", 0],
        ["org_2", 1],
      ]);
    });

    it("skips the grouped query entirely for an empty page (boundary)", async () => {
      const prisma = mockPrisma();
      prisma.organization.findMany = findManyOf(orgRow, 0);
      const service = new OrganizationsService(prisma as never, {} as never, {} as never);

      const result = await service.listOrganizations(admin, { limit: 20 });

      expect(result.items).toEqual([]);
      expect(prisma.issuer.groupBy).not.toHaveBeenCalled();
    });

    it("counts issuers only for organizations on the visible page (tenant isolation)", async () => {
      const prisma = mockPrisma();
      const service = new OrganizationsService(prisma as never, {} as never, {} as never);

      await service.listOrganizations(member, { limit: 4 });

      expect(prisma.organization.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [{ createdById: "user_1" }, { members: { some: { userId: "user_1" } } }],
          }),
        }),
      );
      expect(prisma.issuer.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: { in: ["org_0", "org_1", "org_2", "org_3"] } },
        }),
      );
    });
  });

  describe("issuers", () => {
    const build = (kind: "listIssuers" | "listIssuersPublic") => (prisma: Prisma) => {
      const service = new IssuersService(prisma as never, {} as never);
      return (limit: number) => service[kind]({ limit } as never);
    };

    it("issuers.list stays within budget regardless of page size", async () => {
      expectBudget("issuers.list", await countsAcrossPageSizes(build("listIssuers")));
    });

    it("issuers.listPublic stays within budget regardless of page size", async () => {
      expectBudget("issuers.listPublic", await countsAcrossPageSizes(build("listIssuersPublic")));
    });

    it("the public list never widens beyond ACTIVE issuers", async () => {
      const { prisma } = await countsAcrossPageSizes(build("listIssuersPublic"));
      for (const [args] of prisma.issuer.findMany.mock.calls) {
        expect((args as { where: { status: string } }).where.status).toBe(ResourceStatus.ACTIVE);
      }
    });
  });

  describe("payments.list", () => {
    const build = (prisma: Prisma) => {
      // Built without the full dependency graph: only the list path is under test.
      const service = Object.create(PaymentsService.prototype) as PaymentsService;
      Object.assign(service, {
        prisma,
        addressCipher: { tryReveal: (v: { plaintext: string | null }) => v.plaintext },
        paymentEncryptionKeyring: {},
        stellarNetwork: "testnet",
      });
      return (limit: number) => service.listPayments("user_1", { limit });
    };

    it("stays within budget regardless of page size", async () => {
      expectBudget("payments.list", await countsAcrossPageSizes(build));
    });

    it("is scoped to the requesting user (authorization)", async () => {
      const { prisma } = await countsAcrossPageSizes(build);
      for (const [args] of prisma.payment.findMany.mock.calls) {
        expect((args as { where: { userId: string } }).where.userId).toBe("user_1");
      }
    });
  });

  describe("proofs.list", () => {
    const build = (prisma: Prisma) => {
      const service = Object.create(ProofsService.prototype) as ProofsService;
      Object.assign(service, {
        prisma,
        signedCursorService: { verify: jest.fn(), sign: jest.fn().mockReturnValue("next") },
      });
      return (limit: number) => service.listProofs("user_1", { limit } as never);
    };

    it("stays within budget regardless of page size", async () => {
      expectBudget("proofs.list", await countsAcrossPageSizes(build));
    });

    it("is scoped to the requesting user (authorization)", async () => {
      const { prisma } = await countsAcrossPageSizes(build);
      for (const [args] of prisma.proof.findMany.mock.calls) {
        expect((args as { where: { userId: string } }).where.userId).toBe("user_1");
      }
    });
  });

  describe("api-keys.list", () => {
    const build = (prisma: Prisma) => {
      const service = new ApiKeyService(prisma as never);
      return (limit: number) => service.listKeysForOrganization("org_1", { limit });
    };

    it("stays within budget: scope assignments are a nested select, not a per-key query", async () => {
      expectBudget("api-keys.list", await countsAcrossPageSizes(build));
    });

    it("is scoped to the organization and never selects secret material", async () => {
      const { prisma } = await countsAcrossPageSizes(build);
      for (const [args] of prisma.apiKey.findMany.mock.calls) {
        const a = args as { where: { organizationId: string }; select: Record<string, unknown> };
        expect(a.where.organizationId).toBe("org_1");
        expect(a.select).not.toHaveProperty("secretHash");
        expect(a.select).not.toHaveProperty("hashedSecret");
      }
    });
  });

  describe("webhooks", () => {
    const service = (prisma: Prisma) =>
      new WebhooksService(
        prisma as never,
        {} as never,
        {} as never,
        {} as never,
        config as never,
        {} as never,
      );

    it("webhooks.list stays within budget regardless of page size", async () => {
      const result = await countsAcrossPageSizes((prisma) => {
        const s = service(prisma);
        return (limit) => s.listForOrg("org_1", { limit });
      });
      expectBudget("webhooks.list", result);
    });

    it("webhooks.listDeliveries stays within budget regardless of page size", async () => {
      const result = await countsAcrossPageSizes((prisma) => {
        const s = service(prisma);
        return (limit) => s.listDeliveries("org_1", "wh_1", { limit });
      });
      expectBudget("webhooks.listDeliveries", result);
    });

    it("never exposes the signing secret in the list select", async () => {
      const { prisma } = await countsAcrossPageSizes((p) => {
        const s = service(p);
        return (limit) => s.listForOrg("org_1", { limit });
      });
      for (const [args] of prisma.webhook.findMany.mock.calls) {
        expect((args as { select: Record<string, unknown> }).select).not.toHaveProperty("secretEncrypted");
      }
    });
  });
});

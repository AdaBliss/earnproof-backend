import { Prisma } from "@prisma/client";
import { integrationDatabase } from "./harness/database";
import { seedOrganization, seedUser, seedWebhook } from "./harness/fixtures";
import {
  buildApiKey,
  buildIssuer,
  buildTrustPin,
} from "../../src/testing/factories";
import { TenantContextService, TenantContextError } from "../../src/database/tenant-context.service";
import { PrismaService } from "../../src/database/prisma.service";
import { RLS_TENANT_TABLES } from "../../src/database/rls-policy";

/**
 * Row-level security, exercised against a real PostgreSQL.
 *
 * Requires the integration environment (`TEST_DATABASE_URL`, see
 * docs/integration-testing.md). The unit suite covers the service's
 * validation and the migration file's static shape; only a live database
 * can prove the policies actually filter rows, that `SET LOCAL` scoping
 * survives connection pooling, and that the bypass audit lands.
 *
 * Seeding runs unbound (no tenant context), which the policies permit by
 * design — the compatibility clause — so the harness's normal fixtures
 * keep working unchanged.
 */
const db = integrationDatabase();

describe("row-level security", () => {
  let tenantContext: TenantContextService;
  let orgAId: string;
  let orgBId: string;
  let userAId: string;
  let userBId: string;
  let keyAId: string;
  let keyBId: string;

  beforeEach(async () => {
    tenantContext = new TenantContextService(db.prisma as unknown as PrismaService);

    const userA = await seedUser(db.prisma, "rls-a-user");
    const userB = await seedUser(db.prisma, "rls-b-user");
    userAId = userA.id;
    userBId = userB.id;

    const orgA = await seedOrganization(db.prisma, "rls-a-org", userAId);
    const orgB = await seedOrganization(db.prisma, "rls-b-org", userBId);
    orgAId = orgA.id;
    orgBId = orgB.id;

    // One row per tenant in each protected table.
    const keyA = buildApiKey("rls-a-key", orgAId, userAId);
    const keyB = buildApiKey("rls-b-key", orgBId, userBId);
    keyAId = keyA.id;
    keyBId = keyB.id;
    await db.prisma.apiKey.create({ data: keyA });
    await db.prisma.apiKey.create({ data: keyB });

    await db.prisma.organizationMember.create({
      data: { organizationId: orgAId, userId: userAId, role: "OWNER" },
    });
    await db.prisma.organizationMember.create({
      data: { organizationId: orgBId, userId: userBId, role: "OWNER" },
    });

    await db.prisma.organizationInvitation.create({
      data: {
        organizationId: orgAId,
        role: "MEMBER",
        inviterId: userAId,
        recipientWalletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        recipientWalletHash: "hash-rls-a-invite",
        secretHash: "secret-rls-a-invite",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    await db.prisma.organizationInvitation.create({
      data: {
        organizationId: orgBId,
        role: "MEMBER",
        inviterId: userBId,
        recipientWalletAddress: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        recipientWalletHash: "hash-rls-b-invite",
        secretHash: "secret-rls-b-invite",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    const issuerA = buildIssuer("rls-a-issuer", orgAId);
    const issuerB = buildIssuer("rls-b-issuer", orgBId);
    await db.prisma.issuer.create({ data: issuerA });
    await db.prisma.issuer.create({ data: issuerB });

    await db.prisma.supportedAsset.create({
      data: {
        organizationId: orgAId,
        assetKey: "testnet:native:USDC:rls-a",
        code: "USDC",
        issuer: null,
        network: "testnet",
      },
    });
    await db.prisma.supportedAsset.create({
      data: {
        organizationId: orgBId,
        assetKey: "testnet:native:USDC:rls-b",
        code: "USDC",
        issuer: null,
        network: "testnet",
      },
    });

    await seedWebhook(db.prisma, "rls-a-webhook", orgAId);
    await seedWebhook(db.prisma, "rls-b-webhook", orgBId);

    await db.prisma.secretRetrievalReceipt.create({
      data: {
        organizationId: orgAId,
        secretType: "api_key",
        resourceId: keyAId,
        revealedAt: new Date("2026-11-19T06:00:00.000Z"),
        acknowledgementHash: "sha256:rls-a-receipt",
        hash: "hash-rls-a-receipt",
      },
    });
    await db.prisma.secretRetrievalReceipt.create({
      data: {
        organizationId: orgBId,
        secretType: "api_key",
        resourceId: keyBId,
        revealedAt: new Date("2026-11-19T06:00:00.000Z"),
        acknowledgementHash: "sha256:rls-b-receipt",
        hash: "hash-rls-b-receipt",
      },
    });

    const pinA = buildTrustPin("rls-a-pin", orgAId, issuerA.id);
    const pinB = buildTrustPin("rls-b-pin", orgBId, issuerB.id);
    // The factory's `decisionMetadata.context` is typed `Record<string,
    // unknown>`, which Prisma's `InputJsonValue` does not accept; the
    // value itself is JSON-safe, so it is cast the same way the harness
    // casts webhook event payloads.
    await db.prisma.credentialVerificationKeyTrustPin.create({
      data: {
        ...pinA,
        decisionMetadata: pinA.decisionMetadata as unknown as Prisma.InputJsonValue,
      },
    });
    await db.prisma.credentialVerificationKeyTrustPin.create({
      data: {
        ...pinB,
        decisionMetadata: pinB.decisionMetadata as unknown as Prisma.InputJsonValue,
      },
    });
  });

  it("enables and forces RLS with the tenant policy on every protected table", async () => {
    const rows = await db.prisma.$queryRaw<
      Array<{ table: string; rls: boolean; forced: boolean; policy: string }>
    >`
      SELECT c.relname AS table,
             c.relrowsecurity AS rls,
             c.relforcerowsecurity AS forced,
             p.polname AS policy
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_policy p ON p.polrelid = c.oid
       WHERE n.nspname = 'public'
         AND c.relname = ANY(${[...RLS_TENANT_TABLES]})
    `;

    expect(rows).toHaveLength(RLS_TENANT_TABLES.length);
    for (const row of rows) {
      expect(row.rls).toBe(true);
      // Forced matters: without it the policies would not apply to the
      // table owner, which is the role the application connects as.
      expect(row.forced).toBe(true);
      expect(row.policy).toBe("tenant_isolation");
    }
    expect(rows.map((row) => row.table).sort()).toEqual([...RLS_TENANT_TABLES].sort());
  });

  it("shows each tenant only its own rows when a tenant is bound", async () => {
    const seenByA = await tenantContext.withTenantContext(orgAId, (tx) =>
      tx.apiKey.findMany({ select: { id: true } }),
    );
    const seenByB = await tenantContext.withTenantContext(orgBId, (tx) =>
      tx.apiKey.findMany({ select: { id: true } }),
    );

    expect(seenByA.map((row) => row.id)).toEqual([keyAId]);
    expect(seenByB.map((row) => row.id)).toEqual([keyBId]);
  });

  it("isolates every protected table, not just ApiKey", async () => {
    const countsFor = async (organizationId: string) =>
      tenantContext.withTenantContext(organizationId, async (tx) => ({
        members: await tx.organizationMember.count(),
        invitations: await tx.organizationInvitation.count(),
        issuers: await tx.issuer.count(),
        assets: await tx.supportedAsset.count(),
        webhooks: await tx.webhook.count(),
        receipts: await tx.secretRetrievalReceipt.count(),
        pins: await tx.credentialVerificationKeyTrustPin.count(),
      }));

    expect(await countsFor(orgAId)).toEqual({
      members: 1,
      invitations: 1,
      issuers: 1,
      assets: 1,
      webhooks: 1,
      receipts: 1,
      pins: 1,
    });
    expect(await countsFor(orgBId)).toEqual({
      members: 1,
      invitations: 1,
      issuers: 1,
      assets: 1,
      webhooks: 1,
      receipts: 1,
      pins: 1,
    });
  });

  it("silently hides the other tenant's rows instead of erroring", async () => {
    const otherKey = await tenantContext.withTenantContext(orgAId, (tx) =>
      tx.apiKey.findUnique({ where: { id: keyBId } }),
    );
    expect(otherKey).toBeNull();
  });

  it("lets a bound tenant write its own rows and refuses the other tenant's", async () => {
    const ownKey = await tenantContext.withTenantContext(orgAId, (tx) =>
      tx.apiKey.create({
        data: {
          ...buildApiKey("rls-a-key-2", orgAId, userAId),
        },
      }),
    );
    expect(ownKey.organizationId).toBe(orgAId);

    await expect(
      tenantContext.withTenantContext(orgAId, (tx) =>
        tx.apiKey.create({
          data: {
            ...buildApiKey("rls-b-key-2", orgBId, userBId),
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("makes cross-tenant updates and deletes affect zero rows", async () => {
    const updated = await tenantContext.withTenantContext(orgAId, (tx) =>
      tx.apiKey.updateMany({ where: { id: keyBId }, data: { name: "hijacked" } }),
    );
    expect(updated.count).toBe(0);

    const deleted = await tenantContext.withTenantContext(orgAId, (tx) =>
      tx.apiKey.deleteMany({ where: { id: keyBId } }),
    );
    expect(deleted.count).toBe(0);

    // The row is still there, untouched.
    expect(await db.prisma.apiKey.findUnique({ where: { id: keyBId } })).not.toBeNull();
  });

  it("keeps the legacy unbound behavior: no context sees every row", async () => {
    const keys = await db.prisma.apiKey.findMany({ select: { id: true } });
    expect(keys.map((row) => row.id).sort()).toEqual([keyAId, keyBId].sort());
  });

  it("does not leak a bound tenant onto a later unbound query", async () => {
    await tenantContext.withTenantContext(orgAId, (tx) =>
      tx.apiKey.findMany({ select: { id: true } }),
    );

    // Same client, later checkout: the setting died with the transaction.
    const keys = await db.prisma.apiKey.findMany({ select: { id: true } });
    expect(keys.map((row) => row.id).sort()).toEqual([keyAId, keyBId].sort());
  });

  it("keeps concurrent tenants isolated on different pooled connections", async () => {
    const [seenByA, seenByB] = await Promise.all([
      tenantContext.withTenantContext(orgAId, (tx) =>
        tx.apiKey.findMany({ select: { id: true } }),
      ),
      tenantContext.withTenantContext(orgBId, (tx) =>
        tx.apiKey.findMany({ select: { id: true } }),
      ),
    ]);

    expect(seenByA.map((row) => row.id)).toEqual([keyAId]);
    expect(seenByB.map((row) => row.id)).toEqual([keyBId]);
  });

  it("reports the bound tenant inside the transaction and none outside it", async () => {
    const inside = await tenantContext.withTenantContext(orgAId, (tx) =>
      tenantContext.readTenantContext(tx),
    );
    expect(inside).toBe(orgAId);

    const outside = await db.prisma.$transaction((tx) => tenantContext.readTenantContext(tx));
    expect(outside).toBeNull();
  });

  it("rejects an invalid tenant before any SQL runs", async () => {
    await expect(
      tenantContext.withTenantContext("not an id", (tx) => tx.apiKey.findMany()),
    ).rejects.toBeInstanceOf(TenantContextError);
  });

  it("lets the audited bypass see every tenant, and records the bypass", async () => {
    const seen = await tenantContext.withBypassContext(
      { reason: "cross-tenant reconciliation check", actor: "rls-test", organizationId: orgAId },
      (tx) => tx.apiKey.findMany({ select: { id: true } }),
    );
    expect(seen.map((row) => row.id).sort()).toEqual([keyAId, keyBId].sort());

    const audits = await db.prisma.rlsBypassAudit.findMany();
    expect(audits).toHaveLength(1);
    expect(audits[0].reason).toBe("cross-tenant reconciliation check");
    expect(audits[0].actor).toBe("rls-test");
    expect(audits[0].organizationId).toBe(orgAId);
  });

  it("lets the bypass write across tenants, and rejects an unjustified bypass", async () => {
    await tenantContext.withBypassContext(
      { reason: "rename the other tenant's key", actor: "rls-test" },
      (tx) => tx.apiKey.update({ where: { id: keyBId }, data: { name: "renamed by maintenance" } }),
    );
    const renamed = await db.prisma.apiKey.findUnique({ where: { id: keyBId } });
    expect(renamed?.name).toBe("renamed by maintenance");

    await expect(
      tenantContext.withBypassContext({ reason: "   ", actor: "rls-test" }, async () => undefined),
    ).rejects.toBeInstanceOf(TenantContextError);
    expect(await db.prisma.rlsBypassAudit.count()).toBe(1);
  });

  it("leaves unprotected tables untouched: organizations stay readable unbound", async () => {
    const orgs = await db.prisma.organization.findMany({ select: { id: true } });
    expect(orgs.map((row) => row.id).sort()).toEqual([orgAId, orgBId].sort());
  });
});

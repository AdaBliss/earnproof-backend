import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "./prisma.service";
import {
  TenantContextError,
  TenantContextService,
  validateBypassActor,
  validateBypassReason,
  validateOrganizationId,
} from "./tenant-context.service";
import {
  MAX_BYPASS_ACTOR_LENGTH,
  MAX_BYPASS_REASON_LENGTH,
  MAX_ORGANIZATION_ID_LENGTH,
  RLS_BYPASS_ACTIVE_VALUE,
  RLS_BYPASS_REASON_SETTING,
  RLS_BYPASS_SETTING,
  RLS_TENANT_SETTING,
} from "./rls-policy";

/**
 * Renders a mocked `$executeRaw` / `$queryRaw` call back into readable SQL.
 *
 * Prisma template-literal calls arrive as `(strings, ...values)`; joining the
 * string parts with `$n` placeholders shows exactly what PostgreSQL receives
 * without ever interpolating a value into the statement text.
 */
function renderedSql(call: unknown[]): string {
  const strings = call[0] as unknown as TemplateStringsArray;
  const values = call.slice(1);
  return strings.reduce(
    (sql, part, index) => sql + part + (index < values.length ? `$${index + 1}` : ""),
    "",
  );
}

function boundValues(call: unknown[]): unknown[] {
  return call.slice(1);
}

describe("TenantContextService", () => {
  let service: TenantContextService;
  let prismaService: jest.Mocked<PrismaService>;

  // The transaction client the mocked `$transaction` hands to the callback.
  let tx: {
    $executeRaw: jest.Mock;
    $queryRaw: jest.Mock;
    rlsBypassAudit: { create: jest.Mock };
  };

  beforeEach(async () => {
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn(),
      rlsBypassAudit: { create: jest.fn().mockResolvedValue({ id: "audit-row" }) },
    };

    const mockPrismaService = {
      $transaction: jest.fn().mockImplementation(async (callback: (tx: unknown) => unknown) => callback(tx)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantContextService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<TenantContextService>(TenantContextService);
    prismaService = module.get(PrismaService);
  });

  describe("withTenantContext", () => {
    it("binds the tenant transaction-locally and runs the work on that transaction", async () => {
      const work = jest.fn().mockResolvedValue("done");

      const result = await service.withTenantContext("cm123org", work);

      expect(result).toBe("done");
      expect(prismaService.$transaction).toHaveBeenCalledTimes(1);
      expect(work).toHaveBeenCalledTimes(1);
      expect(work).toHaveBeenCalledWith(tx);

      const calls = tx.$executeRaw.mock.calls;
      expect(calls).toHaveLength(1);
      expect(renderedSql(calls[0])).toContain("SELECT set_config($1, $2, true)");
      expect(boundValues(calls[0])).toEqual([RLS_TENANT_SETTING, "cm123org"]);
    });

    it("never issues a session-level SET: the binding cannot outlive its transaction", async () => {
      await service.withTenantContext("cm123org", async () => undefined);

      for (const call of tx.$executeRaw.mock.calls) {
        const sql = renderedSql(call);
        expect(sql).not.toMatch(/^\s*SET\s/m);
        expect(sql).not.toMatch(/SET\s+LOCAL/m);
        expect(sql).toContain("set_config");
      }
    });

    it("never interpolates the organization id into the statement text", async () => {
      await service.withTenantContext("cm123org", async () => undefined);

      const strings = tx.$executeRaw.mock.calls[0][0] as unknown as TemplateStringsArray;
      expect(strings.join("")).not.toContain("cm123org");
    });

    it("propagates work errors and still used exactly one transaction", async () => {
      const failure = new Error("work failed");

      await expect(
        service.withTenantContext("cm123org", async () => {
          throw failure;
        }),
      ).rejects.toThrow("work failed");
      expect(prismaService.$transaction).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["empty string", ""],
      ["whitespace only", "   "],
      ["null", null],
      ["undefined", undefined],
      ["a number", 42],
      ["an object", { id: "cm123org" }],
      ["a space inside the id", "org id"],
      ["a quote", "org'id"],
      ["a semicolon", "org; DROP TABLE"],
      ["a newline", "org\nid"],
      ["a slash", "org/id"],
      ["over the length bound", "a".repeat(MAX_ORGANIZATION_ID_LENGTH + 1)],
    ])("rejects an invalid organization id (%s) before any SQL runs", async (_label, badId) => {
      await expect(
        service.withTenantContext(badId as never, async () => "never"),
      ).rejects.toBeInstanceOf(TenantContextError);
      expect(prismaService.$transaction).not.toHaveBeenCalled();
    });

    it.each([
      ["single character", "a"],
      ["cuid-shaped", "cm123org456"],
      ["uuid-shaped", "123e4567-e89b-12d3-a456-426614174000"],
      ["exactly at the length bound", "a".repeat(MAX_ORGANIZATION_ID_LENGTH)],
    ])("accepts a valid organization id (%s)", async (_label, goodId) => {
      await expect(service.withTenantContext(goodId, async () => "ok")).resolves.toBe("ok");
    });
  });

  describe("withBypassContext", () => {
    it("sets the bypass flag and reason, audits the bypass, then runs the work", async () => {
      const work = jest.fn().mockResolvedValue("done");

      const result = await service.withBypassContext(
        { reason: "backfill org slugs", actor: "backfill-job", organizationId: "cm123org" },
        work,
      );

      expect(result).toBe("done");
      expect(prismaService.$transaction).toHaveBeenCalledTimes(1);

      const calls = tx.$executeRaw.mock.calls;
      expect(calls).toHaveLength(2);
      expect(renderedSql(calls[0])).toContain("SELECT set_config($1, $2, true)");
      expect(boundValues(calls[0])).toEqual([RLS_BYPASS_SETTING, RLS_BYPASS_ACTIVE_VALUE]);
      expect(renderedSql(calls[1])).toContain("SELECT set_config($1, $2, true)");
      expect(boundValues(calls[1])).toEqual([RLS_BYPASS_REASON_SETTING, "backfill org slugs"]);

      expect(tx.rlsBypassAudit.create).toHaveBeenCalledTimes(1);
      expect(tx.rlsBypassAudit.create).toHaveBeenCalledWith({
        data: { reason: "backfill org slugs", actor: "backfill-job", organizationId: "cm123org" },
      });
      expect(work).toHaveBeenCalledTimes(1);
      expect(work).toHaveBeenCalledWith(tx);
    });

    it("records a null organization when the maintenance is not scoped to one tenant", async () => {
      await service.withBypassContext(
        { reason: "cross-tenant repair", actor: "incident-response" },
        async () => undefined,
      );

      expect(tx.rlsBypassAudit.create).toHaveBeenCalledWith({
        data: { reason: "cross-tenant repair", actor: "incident-response", organizationId: null },
      });
    });

    it("writes the audit row before running the work, so a failure cannot skip the record", async () => {
      const invocationOrder: string[] = [];
      tx.rlsBypassAudit.create.mockImplementation(async () => {
        invocationOrder.push("audit");
        return { id: "audit-row" };
      });

      await expect(
        service.withBypassContext({ reason: "repair", actor: "job" }, async () => {
          invocationOrder.push("work");
          throw new Error("work failed");
        }),
      ).rejects.toThrow("work failed");

      expect(invocationOrder).toEqual(["audit", "work"]);
    });

    it.each([
      ["empty reason", "", "job", undefined],
      ["whitespace reason", "   ", "job", undefined],
      ["over-long reason", "r".repeat(MAX_BYPASS_REASON_LENGTH + 1), "job", undefined],
      ["reason with a control character", "repair\nnow", "job", undefined],
      ["non-string reason", 42 as never, "job", undefined],
      ["empty actor", "repair", "", undefined],
      ["whitespace actor", "repair", "   ", undefined],
      ["over-long actor", "repair", "a".repeat(MAX_BYPASS_ACTOR_LENGTH + 1), undefined],
      ["actor with a control character", "repair", "job\tname", undefined],
      ["non-string actor", "repair", 42 as never, undefined],
      ["invalid organization id", "repair", "job", "bad org"],
    ])("rejects invalid bypass input (%s) before any SQL runs", async (_label, reason, actor, organizationId) => {
      await expect(
        service.withBypassContext(
          { reason: reason as never, actor: actor as never, organizationId: organizationId as never },
          async () => "never",
        ),
      ).rejects.toBeInstanceOf(TenantContextError);
      expect(prismaService.$transaction).not.toHaveBeenCalled();
      expect(tx.rlsBypassAudit.create).not.toHaveBeenCalled();
    });

    it("trims the reason and actor before recording them", async () => {
      await service.withBypassContext(
        { reason: "  repair  ", actor: "  job  " },
        async () => undefined,
      );

      expect(tx.rlsBypassAudit.create).toHaveBeenCalledWith({
        data: { reason: "repair", actor: "job", organizationId: null },
      });
    });
  });

  describe("readTenantContext", () => {
    it("returns the bound organization id", async () => {
      tx.$queryRaw.mockResolvedValue([{ value: "cm123org" }]);

      await expect(service.readTenantContext(tx as never)).resolves.toBe("cm123org");
      expect(renderedSql(tx.$queryRaw.mock.calls[0])).toContain("current_setting($1, true)");
      expect(boundValues(tx.$queryRaw.mock.calls[0])).toEqual([RLS_TENANT_SETTING]);
    });

    it("returns null when no tenant is bound (NULL setting)", async () => {
      tx.$queryRaw.mockResolvedValue([{ value: null }]);

      await expect(service.readTenantContext(tx as never)).resolves.toBeNull();
    });

    it("returns null when the setting is an empty string", async () => {
      tx.$queryRaw.mockResolvedValue([{ value: "" }]);

      await expect(service.readTenantContext(tx as never)).resolves.toBeNull();
    });
  });

  describe("validators", () => {
    it("validateOrganizationId accepts the boundary lengths", () => {
      expect(validateOrganizationId("a")).toBe("a");
      expect(validateOrganizationId("a".repeat(MAX_ORGANIZATION_ID_LENGTH))).toBe(
        "a".repeat(MAX_ORGANIZATION_ID_LENGTH),
      );
      expect(() => validateOrganizationId("a".repeat(MAX_ORGANIZATION_ID_LENGTH + 1))).toThrow(
        TenantContextError,
      );
    });

    it("validateBypassReason enforces the length bound", () => {
      expect(validateBypassReason("r".repeat(MAX_BYPASS_REASON_LENGTH))).toHaveLength(
        MAX_BYPASS_REASON_LENGTH,
      );
      expect(() => validateBypassReason("r".repeat(MAX_BYPASS_REASON_LENGTH + 1))).toThrow(
        TenantContextError,
      );
    });

    it("validateBypassActor enforces the length bound", () => {
      expect(validateBypassActor("a".repeat(MAX_BYPASS_ACTOR_LENGTH))).toHaveLength(
        MAX_BYPASS_ACTOR_LENGTH,
      );
      expect(() => validateBypassActor("a".repeat(MAX_BYPASS_ACTOR_LENGTH + 1))).toThrow(
        TenantContextError,
      );
    });
  });
});

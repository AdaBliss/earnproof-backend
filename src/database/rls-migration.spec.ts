import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { migrationSafetyIssues } from "../../scripts/migration-safety";
import { RLS_TENANT_TABLES, RLS_TENANT_POLICY_NAME } from "./rls-policy";

const MIGRATION_DIR = "20261217050000_add_row_level_security_tenant_isolation";
const MIGRATIONS_DIR = resolve("prisma", "migrations");
const MIGRATION_SQL = readFileSync(
  join(MIGRATIONS_DIR, MIGRATION_DIR, "migration.sql"),
  "utf8",
);

/**
 * The `RlsBypassAudit` table is enforced by the database in CI
 * (`test/integration/schema-migrations` asserts the migrated schema matches
 * `schema.prisma`); these assertions are the part that can run without a
 * database, so a missing policy or a weakened predicate fails the fast
 * unit suite instead of waiting for an integration run.
 */

/** The SQL block for one table, from its ENABLE statement to the next table's. */
function tableBlock(table: string): string {
  const start = MIGRATION_SQL.indexOf(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = RLS_TENANT_TABLES.filter((other) => other !== table)
    .map((other) => MIGRATION_SQL.indexOf(`ALTER TABLE "${other}" ENABLE ROW LEVEL SECURITY;`, start + 1))
    .filter((index) => index > start);
  const end = next.length ? Math.min(...next) : MIGRATION_SQL.length;
  return MIGRATION_SQL.slice(start, end);
}

/** How many times `needle` occurs in `haystack`. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("row-level-security migration", () => {
  it("creates the bypass audit table with the columns schema.prisma declares", () => {
    expect(MIGRATION_SQL).toContain('CREATE TABLE "RlsBypassAudit"');
    for (const column of [
      '"id" TEXT NOT NULL',
      '"reason" TEXT NOT NULL',
      '"actor" TEXT NOT NULL',
      '"organizationId" TEXT',
      '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP',
    ]) {
      expect(MIGRATION_SQL).toContain(column);
    }
    expect(MIGRATION_SQL).toContain('CONSTRAINT "RlsBypassAudit_pkey" PRIMARY KEY ("id")');
    expect(MIGRATION_SQL).toContain(
      'FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE',
    );
    for (const index of [
      '"RlsBypassAudit_createdAt_idx"',
      '"RlsBypassAudit_actor_createdAt_idx"',
      '"RlsBypassAudit_organizationId_createdAt_idx"',
    ]) {
      expect(MIGRATION_SQL).toContain(index);
    }
  });

  it("protects exactly the tables the policy constants list, no more and no fewer", () => {
    const enabled = [...MIGRATION_SQL.matchAll(/ALTER TABLE "(\w+)" ENABLE ROW LEVEL SECURITY;/g)].map(
      ([, table]) => table,
    );
    expect(enabled.sort()).toEqual([...RLS_TENANT_TABLES].sort());
  });

  it.each(RLS_TENANT_TABLES)("enables and forces RLS with a tenant policy on %s", (table) => {
    const block = tableBlock(table);
    expect(block).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
    expect(block).toContain(`DROP POLICY IF EXISTS "${RLS_TENANT_POLICY_NAME}" ON "${table}";`);
    expect(block).toContain(`CREATE POLICY "${RLS_TENANT_POLICY_NAME}" ON "${table}"`);
  });

  it.each(RLS_TENANT_TABLES)(
    "constrains reads and writes identically on %s (USING matches WITH CHECK)",
    (table) => {
      const block = tableBlock(table);
      // The predicate is deliberately duplicated, not shared, because
      // PostgreSQL has no policy templating: USING governs reads/updates/
      // deletes and WITH CHECK governs inserts/updates. Each clause of the
      // predicate must appear exactly twice — once per clause — so a
      // future edit that weakens one side fails here.
      const predicateLines = [
        "current_setting('app.current_organization_id', true) IS NULL",
        "current_setting('app.current_organization_id', true) = ''",
        '"organizationId" = current_setting(\'app.current_organization_id\', true)',
        "current_setting('app.rls_bypass', true) = '1'",
      ];
      for (const line of predicateLines) {
        expect(count(block, line)).toBe(2);
      }
    },
  );

  it("never uses a session-level SET, which could leak across pooled connections", () => {
    // `SET LOCAL` would be acceptable in principle, but the service binds
    // context with `set_config(..., true)` instead, so even that must not
    // appear: any SET in this file is a mistake.
    expect(MIGRATION_SQL).not.toMatch(/^\s*SET\s/m);
    expect(MIGRATION_SQL).not.toMatch(/SET\s+LOCAL/m);
  });

  it("contains no destructive SQL", () => {
    expect(MIGRATION_SQL).not.toMatch(/\bDROP\s+(TABLE|COLUMN|TYPE|SCHEMA)\b/i);
    expect(MIGRATION_SQL).not.toMatch(/\bALTER\s+COLUMN\b.*\bSET\s+NOT\s+NULL\b/i);
  });

  it("uses a unique migration timestamp", () => {
    const timestamp = MIGRATION_DIR.slice(0, 14);
    const siblings = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(siblings.filter((name) => name.startsWith(timestamp))).toEqual([MIGRATION_DIR]);
  });

  it("adds no new migration-safety issue beyond the pre-existing duplicate timestamp", () => {
    // Baseline (pristine develop): exactly one issue, the grandfathered
    // duplicate timestamp 20261217040000 shared by
    // `20261217040000_add_api_key_overlap_rotation_cutover_policy` and
    // `20261217040000_add_organization_invitations`. This migration must
    // not add a second one; the pre-existing failure itself is out of
    // scope for this change and is tracked separately.
    const issues = migrationSafetyIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("timestamp");
    expect(issues[0].migration).toContain("20261217040000_add_api_key_overlap_rotation_cutover_policy");
    expect(issues[0].migration).toContain("20261217040000_add_organization_invitations");
  });
});

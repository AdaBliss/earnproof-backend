/**
 * Shared logic for generating and checking the dependency inventory (SBOM).
 *
 * Everything here reads `package.json` and `package-lock.json` only. No
 * `npm install` / `node_modules` walk is required, which is what makes the
 * inventory reproducible: two people (or a CI runner and a laptop) with the
 * same lockfile always produce byte-identical output, and generation does not
 * depend on whatever happens to be installed locally at the time.
 *
 * npm's lockfile v3 format already carries what we need per package: the
 * resolved `version`, an SPDX `license` string (when the package's own
 * `package.json` declares one), and a `dev` flag distinguishing the
 * devDependencies subtree from the production subtree. That is the same data
 * `npm ls` or a live `node_modules` scan would produce, without needing either.
 */
import { readFileSync } from "fs";
import { join } from "path";

export const REPO_ROOT = join(__dirname, "..", "..");

export interface LockPackage {
  version?: string;
  license?: string;
  licenses?: unknown;
  dev?: boolean;
  optional?: boolean;
  peer?: boolean;
  resolved?: string;
  integrity?: string;
}

export interface PackageLock {
  name: string;
  version: string;
  lockfileVersion: number;
  packages: Record<string, LockPackage>;
}

export interface PackageJson {
  name: string;
  version: string;
  license?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface InventoryEntry {
  name: string;
  version: string;
  license: string;
  category: "runtime" | "build";
  owner: string;
  purpose: string;
}

export interface Inventory {
  generatedFrom: {
    lockfileVersion: number;
    packageVersion: string;
  };
  runtime: InventoryEntry[];
  build: InventoryEntry[];
}

export function readPackageJson(): PackageJson {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
  ) as PackageJson;
}

export function readPackageLock(): PackageLock {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8"),
  ) as PackageLock;
}

const DEFAULT_OWNER = "backend team";

/**
 * Purpose annotations for every direct dependency, keyed by package name.
 *
 * These are written by hand rather than inferred at generation time, because
 * "why do we depend on this" is a judgment call an import grep cannot make
 * reliably (a package imported only in a spec file is not the same kind of
 * dependency as one used in a request path). Each entry names the actual
 * directories that import the package so the claim is checkable, and
 * `verifyPurposeAnnotations` (in check.ts) fails CI if a package stops being
 * imported anywhere those directories say it is, or a new direct dependency
 * has no entry at all.
 */
export const PURPOSES: Record<string, { purpose: string; paths: string[] }> = {
  "@nestjs/cli": {
    purpose: "Nest CLI used by the build script (`nest build`) and local dev server.",
    paths: ["package.json#scripts"],
  },
  "@nestjs/common": {
    purpose: "Core Nest decorators, pipes, guards, and exceptions used throughout every module.",
    paths: ["src/"],
  },
  "@nestjs/config": {
    purpose: "Typed environment configuration loading and validation.",
    paths: ["src/config/"],
  },
  "@nestjs/core": {
    purpose: "Nest application runtime — bootstraps the app, DI container, and HTTP adapter.",
    paths: ["src/main.ts", "src/app.module.ts"],
  },
  "@nestjs/platform-express": {
    purpose: "Express HTTP adapter Nest runs on.",
    paths: ["src/main.ts"],
  },
  "@nestjs/schedule": {
    purpose: "Cron scheduling for background jobs (anchoring worker, retention sweep, auth cleanup).",
    paths: ["src/jobs/", "src/auth/cleanup.job.ts"],
  },
  "@nestjs/swagger": {
    purpose: "OpenAPI document generation for the published API contract.",
    paths: ["src/main.ts", "src/openapi.spec.ts"],
  },
  "@nestjs/throttler": {
    purpose: "Rate limiting for auth and public verification endpoints.",
    paths: ["src/auth/", "src/app.module.ts"],
  },
  "@prisma/client": {
    purpose: "Generated database client used by every service that reads or writes Postgres.",
    paths: ["src/database/", "prisma/"],
  },
  "@stellar/stellar-base": {
    purpose: "Low-level Stellar primitives (keys, XDR, transactions) underlying the SDK.",
    paths: ["src/stellar/"],
  },
  "@stellar/stellar-sdk": {
    purpose: "Stellar network client — Horizon queries, payment sync, contract anchoring.",
    paths: ["src/stellar/", "src/payments/", "src/proofs/contract-anchoring.service.ts"],
  },
  "@types/express": {
    purpose: "Type definitions for Express request/response objects used in guards and interceptors.",
    paths: ["src/common/"],
  },
  ajv: {
    purpose: "JSON Schema validation for OpenAPI document and webhook conformance vectors.",
    paths: ["src/openapi.spec.ts", "scripts/webhook-receiver/"],
  },
  "class-transformer": {
    purpose: "DTO (de)serialization for request/response payload transformation.",
    paths: ["src/**/dto/"],
  },
  "class-validator": {
    purpose: "Declarative DTO validation on every inbound request payload.",
    paths: ["src/**/dto/"],
  },
  helmet: {
    purpose: "HTTP security headers applied to every response.",
    paths: ["src/main.ts"],
  },
  prisma: {
    purpose: "Prisma CLI/toolkit — schema migrations and client generation.",
    paths: ["prisma/", "package.json#scripts"],
  },
  "reflect-metadata": {
    purpose: "Decorator metadata reflection required by Nest's DI and class-validator.",
    paths: ["src/main.ts"],
  },
  rxjs: {
    purpose: "Reactive primitives used by Nest internals and a small number of stream-based services.",
    paths: ["src/"],
  },
  zod: {
    purpose: "Runtime schema validation for environment variables and select external payloads.",
    paths: ["src/config/env.validation.ts"],
  },
  "@apidevtools/swagger-parser": {
    purpose: "Validates the generated OpenAPI document is spec-compliant in tests.",
    paths: ["src/openapi.spec.ts"],
  },
  "@nestjs/schematics": {
    purpose: "Code generation schematics for the Nest CLI (dev-time only).",
    paths: ["package.json#devDependencies"],
  },
  "@nestjs/testing": {
    purpose: "Nest's testing module builder used by every unit and integration spec.",
    paths: ["src/**/*.spec.ts", "test/"],
  },
  "@types/jest": {
    purpose: "Type definitions for the Jest test runner.",
    paths: ["src/**/*.spec.ts"],
  },
  "@types/node": {
    purpose: "Node.js standard library type definitions.",
    paths: ["src/", "scripts/"],
  },
  "@types/supertest": {
    purpose: "Type definitions for Supertest HTTP assertions in integration specs.",
    paths: ["test/", "src/**/*.spec.ts"],
  },
  "@typescript-eslint/eslint-plugin": {
    purpose: "TypeScript-aware lint rules.",
    paths: ["eslint.config.mjs"],
  },
  "@typescript-eslint/parser": {
    purpose: "TypeScript parser for ESLint.",
    paths: ["eslint.config.mjs"],
  },
  eslint: {
    purpose: "Static analysis / lint enforcement, run in CI on every PR.",
    paths: ["eslint.config.mjs", ".github/workflows/ci.yml"],
  },
  "eslint-config-prettier": {
    purpose: "Disables ESLint rules that conflict with Prettier formatting.",
    paths: ["eslint.config.mjs"],
  },
  jest: {
    purpose: "Unit and integration test runner.",
    paths: ["jest.config.js", "jest.integration.config.js"],
  },
  prettier: {
    purpose: "Code formatting.",
    paths: ["package.json#devDependencies"],
  },
  "source-map-support": {
    purpose: "Maps compiled stack traces back to TypeScript source in test/dev output.",
    paths: ["package.json#devDependencies"],
  },
  supertest: {
    purpose: "HTTP assertions against the Nest app in integration tests.",
    paths: ["test/", "src/**/*.spec.ts"],
  },
  "ts-jest": {
    purpose: "TypeScript transform for Jest.",
    paths: ["jest.config.js"],
  },
  "ts-loader": {
    purpose: "TypeScript loader used by the Nest build pipeline.",
    paths: ["nest-cli.json"],
  },
  "ts-node": {
    purpose: "Runs TypeScript scripts directly (backup drill, webhook receiver, sbom tooling, seeding).",
    paths: ["scripts/", "prisma/seed-demo.ts"],
  },
  "tsconfig-paths": {
    purpose: "Resolves TypeScript path aliases at runtime for ts-node.",
    paths: ["tsconfig.json"],
  },
  typescript: {
    purpose: "TypeScript compiler for the whole codebase.",
    paths: ["tsconfig.json", "tsconfig.build.json"],
  },
  "typescript-eslint": {
    purpose: "Unified TypeScript ESLint tooling entrypoint.",
    paths: ["eslint.config.mjs"],
  },
};

export function purposeFor(name: string): { purpose: string; paths: string[] } {
  return (
    PURPOSES[name] ?? {
      purpose: "No purpose annotation recorded — add one to scripts/sbom/inventory-lib.ts.",
      paths: [],
    }
  );
}

/** The lockfile's root package key is `""`. Every other key is a node_modules path. */
function packageNameFromKey(key: string): string | null {
  if (key === "") return null;
  const match = key.match(/node_modules\/((?:@[^/]+\/)?[^/]+)$/);
  return match ? match[1] : null;
}

function licenseOf(pkg: LockPackage): string {
  if (typeof pkg.license === "string" && pkg.license.length > 0) {
    return pkg.license;
  }
  if (pkg.licenses) {
    return JSON.stringify(pkg.licenses);
  }
  return "UNKNOWN";
}

/**
 * Builds the inventory of direct dependencies only (runtime + build/dev).
 *
 * Transitive dependencies are intentionally excluded from the reviewable
 * inventory document — hundreds of entries with no owner-assignable purpose
 * would bury the ones a human can actually act on. The full transitive tree,
 * including every license actually present, is still covered by
 * `licensesInLockfile` for the drift/license check, so a transitive package
 * introducing a prohibited license is still caught even though it is not a
 * named row in the document.
 */
export function buildInventory(): Inventory {
  const pkg = readPackageJson();
  const lock = readPackageLock();

  const directRuntime = Object.keys(pkg.dependencies ?? {}).sort();
  const directBuild = Object.keys(pkg.devDependencies ?? {}).sort();

  function entryFor(name: string, category: "runtime" | "build"): InventoryEntry {
    const lockEntry = lock.packages[`node_modules/${name}`];
    const version = lockEntry?.version ?? (pkg.dependencies?.[name] || pkg.devDependencies?.[name] || "UNKNOWN");
    const license = lockEntry ? licenseOf(lockEntry) : "UNKNOWN";
    const { purpose } = purposeFor(name);

    return {
      name,
      version,
      license,
      category,
      owner: DEFAULT_OWNER,
      purpose,
    };
  }

  return {
    generatedFrom: {
      lockfileVersion: lock.lockfileVersion,
      packageVersion: pkg.version,
    },
    runtime: directRuntime.map((name) => entryFor(name, "runtime")),
    build: directBuild.map((name) => entryFor(name, "build")),
  };
}

/** Every (package name -> license) pair found anywhere in the lockfile, direct or transitive. */
export function licensesInLockfile(): Map<string, string> {
  const lock = readPackageLock();
  const result = new Map<string, string>();

  for (const [key, value] of Object.entries(lock.packages)) {
    const name = packageNameFromKey(key);
    if (!name) continue;
    result.set(name, licenseOf(value));
  }

  return result;
}

export function renderInventoryMarkdown(inventory: Inventory): string {
  const lines: string[] = [];

  lines.push("<!-- GENERATED FILE. Do not edit by hand — run `npm run sbom:generate`. -->");
  lines.push("<!-- Source of truth: package.json + package-lock.json. See docs/dependencies.md. -->");
  lines.push("");
  lines.push("# Dependency Inventory");
  lines.push("");
  lines.push(
    `Generated from package-lock.json (lockfileVersion ${inventory.generatedFrom.lockfileVersion}), ` +
      `package.json version ${inventory.generatedFrom.packageVersion}.`,
  );
  lines.push("");
  lines.push(
    "This file is regenerated by `npm run sbom:generate` and verified against drift by " +
      "`npm run sbom:check` in CI. Direct dependencies only — see docs/dependencies.md for " +
      "how transitive packages and their licenses are covered.",
  );
  lines.push("");

  function renderSection(title: string, entries: InventoryEntry[]): void {
    lines.push(`## ${title}`);
    lines.push("");
    lines.push("| Package | Version | License | Owner | Purpose |");
    lines.push("|---|---|---|---|---|");
    for (const entry of entries) {
      lines.push(
        `| \`${entry.name}\` | ${entry.version} | ${entry.license} | ${entry.owner} | ${entry.purpose} |`,
      );
    }
    lines.push("");
  }

  renderSection("Runtime dependencies", inventory.runtime);
  renderSection("Build / development dependencies", inventory.build);

  return lines.join("\n") + "\n";
}

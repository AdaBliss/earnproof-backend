/**
 * Focused tests for the SBOM publish + provenance + release-gate complement
 * (scripts/sbom/publish-lib.ts).
 *
 * All fixtures are synthetic lockfiles built in-memory — no git, disk, or
 * database is involved, and no real secret appears anywhere in this file.
 * Where a test needs an env value, it uses an obviously fake token and
 * removes it afterwards.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  buildInventory,
  renderInventoryMarkdown,
  REPO_ROOT,
} from "./inventory-lib";
import {
  buildProvenance,
  buildSbom,
  checkBounds,
  classifySource,
  MAX_COMPONENTS,
  MAX_SBOM_BYTES,
  publicArtifactValues,
  purlFor,
  runReleaseGate,
  scanForSecrets,
  sha256Hex,
  stablePrettyStringify,
  stableStringify,
  validatePackageIdentities,
  type PackageJson,
  type PackageLock,
} from "./publish-lib";
import type { LockPackage } from "./inventory-lib";

const FAKE_TOKEN = "fake-test-token-abcdef1234567890";
const FAKE_GITHUB_TOKEN = "ghp_faketoken1234567890abcdefghij";

function lockPackage(overrides: Partial<LockPackage> = {}): LockPackage {
  return {
    version: "1.0.0",
    license: "MIT",
    resolved: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
    integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
    ...overrides,
  };
}

function makeLock(packages: Record<string, LockPackage>): PackageLock {
  return {
    name: "earnproof-backend",
    version: "0.1.0",
    lockfileVersion: 3,
    packages: { "": { version: "0.1.0" }, ...packages },
  };
}

function makePkg(): PackageJson {
  return {
    name: "earnproof-backend",
    version: "0.1.0",
    license: "Apache-2.0",
    dependencies: { express: "^4.0.0" },
    devDependencies: { jest: "^30.0.0" },
  };
}

const WELL_FORMED_LOCK = makeLock({
  "node_modules/express": lockPackage({
    version: "4.21.0",
    resolved: "https://registry.npmjs.org/express/-/express-4.21.0.tgz",
  }),
  "node_modules/jest": lockPackage({
    version: "30.2.0",
    resolved: "https://registry.npmjs.org/jest/-/jest-30.2.0.tgz",
  }),
  "node_modules/@nestjs/common": lockPackage({
    version: "11.1.28",
    resolved: "https://registry.npmjs.org/@nestjs/common/-/common-11.1.28.tgz",
  }),
  // Nested duplicate install of the same name@version: deduped in the SBOM.
  "node_modules/express/node_modules/qs": lockPackage({
    version: "6.13.0",
    resolved: "https://registry.npmjs.org/qs/-/qs-6.13.0.tgz",
  }),
  "node_modules/qs": lockPackage({
    version: "6.13.0",
    resolved: "https://registry.npmjs.org/qs/-/qs-6.13.0.tgz",
  }),
});

const LOCKFILE_TEXT = JSON.stringify(WELL_FORMED_LOCK);

function committedSbomText(pkg: PackageJson, lock: PackageLock, text: string): string {
  return `${stablePrettyStringify(buildSbom(pkg, lock, text))}\n`;
}

function goodProvenance(pkg: PackageJson, lock: PackageLock, text: string, sbomText: string) {
  return buildProvenance({
    repositoryUrl: "https://github.com/veridatum-labs/earnproof-backend.git",
    commitSha: "a".repeat(40),
    commitDate: "2026-11-19T00:00:00.000Z",
    lockfileHash: sha256Hex(text),
    sbomHash: sha256Hex(sbomText),
  });
}

function passingGateInput() {
  const pkg = makePkg();
  const sbomText = committedSbomText(pkg, WELL_FORMED_LOCK, LOCKFILE_TEXT);
  return {
    pkg,
    lock: WELL_FORMED_LOCK,
    lockfileText: LOCKFILE_TEXT,
    committedSbomText: sbomText,
    provenance: goodProvenance(pkg, WELL_FORMED_LOCK, LOCKFILE_TEXT, sbomText),
  };
}

describe("buildSbom (positive)", () => {
  it("covers the full tree, sorted by name then version, deduplicated by name@version", () => {
    const sbom = buildSbom(makePkg(), WELL_FORMED_LOCK, LOCKFILE_TEXT);
    const names = sbom.components.map((c) => `${c.name}@${c.version}`);
    expect(names).toEqual([
      "@nestjs/common@11.1.28",
      "express@4.21.0",
      "jest@30.2.0",
      "qs@6.13.0",
    ]);
    expect(sbom.bomFormat).toBe("CycloneDX");
    expect(sbom.specVersion).toBe("1.6");
    expect(sbom.version).toBe(1);
  });

  it("is deterministic: two builds from the same lockfile are byte-identical", () => {
    const first = stableStringify(buildSbom(makePkg(), WELL_FORMED_LOCK, LOCKFILE_TEXT));
    const second = stableStringify(buildSbom(makePkg(), WELL_FORMED_LOCK, LOCKFILE_TEXT));
    expect(first).toBe(second);
    const prettyFirst = stablePrettyStringify(buildSbom(makePkg(), WELL_FORMED_LOCK, LOCKFILE_TEXT));
    const prettySecond = stablePrettyStringify(buildSbom(makePkg(), WELL_FORMED_LOCK, LOCKFILE_TEXT));
    expect(prettyFirst).toBe(prettySecond);
    expect(JSON.parse(prettyFirst)).toEqual(JSON.parse(first));
    expect(buildSbom(makePkg(), WELL_FORMED_LOCK, LOCKFILE_TEXT).serialNumber).toBe(
      buildSbom(makePkg(), WELL_FORMED_LOCK, LOCKFILE_TEXT).serialNumber,
    );
  });

  it("records the lockfile hash in metadata and marks direct vs transitive categories", () => {
    const sbom = buildSbom(makePkg(), WELL_FORMED_LOCK, LOCKFILE_TEXT);
    const lockfileHash = sbom.metadata.properties.find(
      (p) => p.name === "earnproof:lockfileHash",
    )?.value;
    expect(lockfileHash).toBe(sha256Hex(LOCKFILE_TEXT));
    const byName = new Map(sbom.components.map((c) => [c.name, c]));
    const category = (name: string) =>
      byName.get(name)?.properties.find((p) => p.name === "earnproof:category")?.value;
    expect(category("express")).toBe("runtime");
    expect(category("jest")).toBe("build");
    expect(category("@nestjs/common")).toBe("transitive");
  });

  it("encodes scoped purls and parses integrity hashes", () => {
    expect(purlFor("@nestjs/common", "11.1.28")).toBe("pkg:npm/%40nestjs/common@11.1.28");
    const sbom = buildSbom(makePkg(), WELL_FORMED_LOCK, LOCKFILE_TEXT);
    const nest = sbom.components.find((c) => c.name === "@nestjs/common");
    expect(nest?.purl).toBe("pkg:npm/%40nestjs/common@11.1.28");
    expect(nest?.hashes).toEqual([{ alg: "SHA-512", content: expect.any(String) }]);
    expect(nest?.licenses).toEqual([{ license: { name: "MIT" } }]);
    expect(nest?.externalReferences).toEqual([
      { type: "distribution", url: "https://registry.npmjs.org/@nestjs/common/-/common-11.1.28.tgz" },
    ]);
  });
});

describe("source classification and package identities (negative)", () => {
  it("classifies an approved registry host as known and anything else as unknown", () => {
    expect(classifySource("https://registry.npmjs.org/a/-/a-1.0.0.tgz").source).toBe("registry");
    expect(classifySource("https://evil.example.com/a-1.0.0.tgz").source).toBe("unknown");
    expect(classifySource("http://registry.npmjs.org/a-1.0.0.tgz").source).toBe("unknown");
    expect(classifySource("git+https://github.com/org/repo.git").source).toBe("unknown");
    expect(classifySource(undefined).source).toBe("unknown");
    expect(classifySource("not a url").source).toBe("unknown");
  });

  it("fails identity validation for a foreign registry host", () => {
    const lock = makeLock({
      "node_modules/evil": lockPackage({
        resolved: "https://evil.example.com/evil/-/evil-1.0.0.tgz",
      }),
    });
    const result = validatePackageIdentities(lock);
    expect(result.unknownCount).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("evil@1.0.0");
    expect(result.failures[0]).toContain("evil.example.com");
  });

  it("fails identity validation for a package with no recorded source", () => {
    const lock = makeLock({
      "node_modules/nosource": lockPackage({ resolved: undefined, integrity: undefined }),
    });
    const result = validatePackageIdentities(lock);
    expect(result.unknownCount).toBe(1);
    expect(result.failures[0]).toContain("no resolved URL recorded in lockfile");
  });

  it("fails identity validation when a recorded source has no integrity hash", () => {
    const lock = makeLock({
      "node_modules/nohash": lockPackage({ integrity: undefined }),
    });
    const result = validatePackageIdentities(lock);
    expect(result.unknownCount).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("missing integrity hash");
  });

  it("caps the listed failures but still reports the full unknown count", () => {
    const packages: Record<string, LockPackage> = {};
    for (let i = 0; i < 30; i++) {
      packages[`node_modules/pkg${i}`] = lockPackage({ resolved: undefined, integrity: undefined });
    }
    const result = validatePackageIdentities(makeLock(packages));
    expect(result.unknownCount).toBe(30);
    expect(result.totalCount).toBe(30);
    expect(result.failures.length).toBeLessThanOrEqual(26);
    expect(result.failures[result.failures.length - 1]).toContain("more unknown-source packages");
  });
});

describe("secret scanning", () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("detects an environment value that leaked into the artifact text", () => {
    process.env.EARNPROOF_TEST_FAKE_TOKEN = FAKE_TOKEN;
    const findings = scanForSecrets(`irrelevant text ${FAKE_TOKEN} more text`, process.env);
    expect(findings).toContainEqual({ kind: "environment-value", identifier: "EARNPROOF_TEST_FAKE_TOKEN" });
  });

  it("detects generic secret patterns without naming the value", () => {
    const findings = scanForSecrets(`token=${FAKE_GITHUB_TOKEN}`, {});
    expect(findings).toContainEqual({ kind: "secret-pattern", identifier: "github-token" });
    const keyFindings = scanForSecrets("-----BEGIN RSA PRIVATE KEY-----", {});
    expect(keyFindings).toContainEqual({ kind: "secret-pattern", identifier: "private-key-header" });
  });

  it("findings never contain the secret value itself", () => {
    process.env.EARNPROOF_TEST_FAKE_TOKEN = FAKE_TOKEN;
    const findings = scanForSecrets(`leak ${FAKE_TOKEN} and ${FAKE_GITHUB_TOKEN}`, process.env);
    expect(JSON.stringify(findings)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(findings)).not.toContain(FAKE_GITHUB_TOKEN);
  });

  it("ignores env values shorter than the minimum length", () => {
    process.env.EARNPROOF_TEST_SHORT = "short7!";
    expect(scanForSecrets("text short7! text", process.env)).toEqual([]);
  });

  it("ignores a bare public URL env value but flags one carrying credentials", () => {
    process.env.EARNPROOF_TEST_REGISTRY = "https://registry.npmjs.org/";
    expect(
      scanForSecrets("resolved https://registry.npmjs.org/a/-/a-1.0.0.tgz", process.env),
    ).toEqual([]);
    process.env.EARNPROOF_TEST_REGISTRY = "https://fake-token-123@registry.npmjs.org/";
    expect(
      scanForSecrets("resolved https://fake-token-123@registry.npmjs.org/a", process.env),
    ).toContainEqual({ kind: "environment-value", identifier: "EARNPROOF_TEST_REGISTRY" });
  });
});

describe("bounds (boundary)", () => {
  it("passes exactly at the component and byte caps", () => {
    expect(checkBounds(MAX_COMPONENTS, MAX_SBOM_BYTES)).toEqual([]);
    expect(checkBounds(0, 0)).toEqual([]);
  });

  it("fails one over either cap", () => {
    expect(checkBounds(MAX_COMPONENTS + 1, 0)).toHaveLength(1);
    expect(checkBounds(0, MAX_SBOM_BYTES + 1)).toHaveLength(1);
    expect(checkBounds(MAX_COMPONENTS + 1, MAX_SBOM_BYTES + 1)).toHaveLength(2);
  });

  it("builds a valid zero-component SBOM for a lockfile with no packages", () => {
    const empty = makeLock({});
    const sbom = buildSbom(makePkg(), empty, JSON.stringify(empty));
    expect(sbom.components).toEqual([]);
    expect(sbom.serialNumber).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
  });
});

describe("provenance and authorization", () => {
  it("strips credentials from the repository URL", () => {
    const provenance = buildProvenance({
      repositoryUrl: "https://user:fake-token-123@github.com/veridatum-labs/earnproof-backend.git",
      commitSha: "b".repeat(40),
      commitDate: "2026-11-19T00:00:00.000Z",
      lockfileHash: "c".repeat(64),
      sbomHash: "d".repeat(64),
    });
    expect(provenance.repositoryUrl).toBe("https://github.com/veridatum-labs/earnproof-backend.git");
    expect(JSON.stringify(provenance)).not.toContain("fake-token-123");
  });

  it("throws on a malformed commit SHA, date, or hash", () => {
    const base = {
      repositoryUrl: null,
      commitSha: "a".repeat(40),
      commitDate: "2026-11-19T00:00:00.000Z",
      lockfileHash: "c".repeat(64),
      sbomHash: "d".repeat(64),
    };
    expect(() => buildProvenance({ ...base, commitSha: "not-a-sha" })).toThrow();
    expect(() => buildProvenance({ ...base, commitDate: "not-a-date" })).toThrow();
    expect(() => buildProvenance({ ...base, lockfileHash: "short" })).toThrow();
    expect(() => buildProvenance({ ...base, commitSha: null })).toThrow(
      "commitSha and commitDate must be provided together",
    );
  });

  it("allows provenance without git state, for tarball builds", () => {
    const provenance = buildProvenance({
      repositoryUrl: null,
      commitSha: null,
      commitDate: null,
      lockfileHash: "c".repeat(64),
      sbomHash: "d".repeat(64),
    });
    expect(provenance.commitSha).toBeNull();
    expect(provenance.commitDate).toBeNull();
  });

  it("never embeds environment values in the SBOM, even when the env holds secrets", () => {
    const saved = { ...process.env };
    process.env.EARNPROOF_TEST_FAKE_TOKEN = FAKE_TOKEN;
    process.env.EARNPROOF_TEST_GITHUB_TOKEN = FAKE_GITHUB_TOKEN;
    try {
      const pkg = makePkg();
      const text = stableStringify(buildSbom(pkg, WELL_FORMED_LOCK, LOCKFILE_TEXT));
      expect(text).not.toContain(FAKE_TOKEN);
      expect(text).not.toContain(FAKE_GITHUB_TOKEN);
      expect(
        scanForSecrets(text, process.env, publicArtifactValues(pkg, null, sha256Hex(LOCKFILE_TEXT))),
      ).toEqual([]);
    } finally {
      process.env = saved;
    }
  });

  it("does not flag intentionally published values as leaks", () => {
    const saved = { ...process.env };
    // CI exposes these as env vars (npm_package_name, GITHUB_SHA,
    // GITHUB_REPOSITORY); the artifacts publish them on purpose.
    process.env.EARNPROOF_TEST_PKG_NAME = "earnproof-backend";
    process.env.EARNPROOF_TEST_COMMIT = "a".repeat(40);
    process.env.EARNPROOF_TEST_REPO = "veridatum-labs/earnproof-backend";
    try {
      const result = runReleaseGate(passingGateInput());
      expect(result.passed).toBe(true);
      expect(result.summary.secretFindings).toBe(0);
    } finally {
      process.env = saved;
    }
  });
});

describe("runReleaseGate", () => {
  it("passes a well-formed SBOM with matching provenance (positive)", () => {
    const result = runReleaseGate(passingGateInput());
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.summary.components).toBe(4);
    expect(result.summary.unknownSources).toBe(0);
    expect(result.summary.secretFindings).toBe(0);
  });

  it("warns, but does not fail, when no source commit is recorded", () => {
    const input = passingGateInput();
    input.provenance = buildProvenance({
      repositoryUrl: null,
      commitSha: null,
      commitDate: null,
      lockfileHash: sha256Hex(LOCKFILE_TEXT),
      sbomHash: sha256Hex(input.committedSbomText),
    });
    const result = runReleaseGate(input);
    expect(result.passed).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("no source commit recorded");
  });

  it("fails on drift when the committed SBOM does not match the lockfile", () => {
    const input = passingGateInput();
    input.committedSbomText = input.committedSbomText.replace("express", "tampered");
    const result = runReleaseGate(input);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes("out of date"))).toBe(true);
  });

  it("fails when the SBOM is not valid JSON", () => {
    const input = passingGateInput();
    input.committedSbomText = "not json";
    const result = runReleaseGate(input);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes("not valid JSON"))).toBe(true);
  });

  it("fails when provenance hashes do not match the lockfile or SBOM", () => {
    const input = passingGateInput();
    input.provenance = buildProvenance({
      repositoryUrl: "https://github.com/veridatum-labs/earnproof-backend.git",
      commitSha: "a".repeat(40),
      commitDate: "2026-11-19T00:00:00.000Z",
      lockfileHash: "e".repeat(64),
      sbomHash: sha256Hex(input.committedSbomText),
    });
    const lockResult = runReleaseGate(input);
    expect(lockResult.passed).toBe(false);
    expect(lockResult.failures.some((f) => f.includes("provenance lockfileHash"))).toBe(true);

    const input2 = passingGateInput();
    input2.provenance = buildProvenance({
      repositoryUrl: "https://github.com/veridatum-labs/earnproof-backend.git",
      commitSha: "a".repeat(40),
      commitDate: "2026-11-19T00:00:00.000Z",
      lockfileHash: sha256Hex(LOCKFILE_TEXT),
      sbomHash: "f".repeat(64),
    });
    const sbomResult = runReleaseGate(input2);
    expect(sbomResult.passed).toBe(false);
    expect(sbomResult.failures.some((f) => f.includes("provenance sbomHash"))).toBe(true);
  });

  it("fails when a secret appears in the committed SBOM, naming the variable not the value", () => {
    const saved = { ...process.env };
    process.env.EARNPROOF_TEST_FAKE_TOKEN = FAKE_TOKEN;
    try {
      const input = passingGateInput();
      input.committedSbomText = `${input.committedSbomText.slice(0, -1)}${FAKE_TOKEN}"\n`;
      const result = runReleaseGate(input);
      expect(result.passed).toBe(false);
      const secretFailures = result.failures.filter((f) => f.includes("secret detected"));
      expect(secretFailures.length).toBeGreaterThan(0);
      expect(JSON.stringify(result.failures)).not.toContain(FAKE_TOKEN);
      expect(JSON.stringify(result.failures)).toContain("EARNPROOF_TEST_FAKE_TOKEN");
    } finally {
      process.env = saved;
    }
  });

  it("fails the gate for a lockfile with unknown sources, even if the SBOM matches it", () => {
    const pkg = makePkg();
    const lock = makeLock({
      "node_modules/nosource": lockPackage({ resolved: undefined, integrity: undefined }),
    });
    const text = JSON.stringify(lock);
    const sbomText = committedSbomText(pkg, lock, text);
    const result = runReleaseGate({
      pkg,
      lock,
      lockfileText: text,
      committedSbomText: sbomText,
      provenance: goodProvenance(pkg, lock, text, sbomText),
    });
    expect(result.passed).toBe(false);
    expect(result.summary.unknownSources).toBe(1);
    expect(result.failures.some((f) => f.includes("unknown dependency source"))).toBe(true);
  });
});

describe("regression: existing inventory machinery is untouched", () => {
  it("SBOM generation has no side effects on the inventory generation", () => {
    const before = renderInventoryMarkdown(buildInventory());
    buildSbom(makePkg(), WELL_FORMED_LOCK, LOCKFILE_TEXT);
    const after = renderInventoryMarkdown(buildInventory());
    expect(after).toBe(before);
  });

  it("the committed inventory.md file is byte-identical after SBOM generation", () => {
    const path = join(REPO_ROOT, "scripts", "sbom", "inventory.md");
    const before = readFileSync(path, "utf8");
    buildSbom(makePkg(), WELL_FORMED_LOCK, LOCKFILE_TEXT);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("inventory-lib still derives from the current package.json, including newer deps", () => {
    const inventory = buildInventory();
    const names = [...inventory.runtime, ...inventory.build].map((e) => e.name);
    expect(names).toContain("range_check");
    expect(names).toContain("undici");
  });
});

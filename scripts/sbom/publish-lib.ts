/**
 * Publish + provenance logic for the machine-readable SBOM.
 *
 * This is the complement to the human-readable inventory in
 * `inventory-lib.ts` / `inventory.md` (direct dependencies only, reviewed by
 * a person) and the drift/license gate in `check.ts`. This module produces
 * the machine-readable CycloneDX SBOM (`scripts/sbom/sbom.cyclonedx.json`)
 * covering the full lockfile tree, attaches release provenance (source
 * commit + lockfile hash + SBOM hash), and enforces the release gate:
 * unknown dependency sources fail, and any environment secret that would
 * leak into the published artifacts fails.
 *
 * Everything here is pure and deterministic: the same lockfile always
 * produces byte-identical output. There is no wall-clock timestamp anywhere
 * in the SBOM or the provenance — the only time recorded is the source
 * commit's own timestamp, which is fixed for a given commit. No environment
 * value is ever embedded in the SBOM or the provenance; the secret scan
 * exists to prove that, not to redact after the fact.
 *
 * `publish.ts` writes the artifacts; `release-gate.ts` re-derives them and
 * fails the release when anything disagrees. Both are thin CLIs over this
 * module so the rules are unit-testable without git, disk, or a database.
 */
import { createHash } from "crypto";
import type { PackageJson, PackageLock } from "./inventory-lib";

export { REPO_ROOT, readPackageJson, readPackageLock } from "./inventory-lib";
export type { PackageJson, PackageLock } from "./inventory-lib";

export const SBOM_SCHEMA_VERSION = "earnproof.sbom.v1";
export const PROVENANCE_SCHEMA_VERSION = "earnproof.release.provenance.v1";
export const SBOM_GENERATOR = `earnproof-sbom-publish/${SBOM_SCHEMA_VERSION}`;

/** Registries a dependency may legitimately be fetched from. */
export const KNOWN_SOURCE_HOSTS = new Set(["registry.npmjs.org"]);

/** Bounds that keep a published SBOM reviewable and a release gate fast. */
export const MAX_COMPONENTS = 5000;
export const MAX_SBOM_BYTES = 5 * 1024 * 1024;

/** Env values shorter than this are too generic to identify a secret. */
export const MIN_SECRET_VALUE_LENGTH = 8;

/** Cap on how many individual failures a gate report lists before summarizing. */
export const MAX_LISTED_FAILURES = 25;

export type DependencySource = "registry" | "unknown";

export interface SourceClassification {
  source: DependencySource;
  host: string | null;
  reason: string | null;
}

export interface SbomComponent {
  "bom-ref": string;
  type: "library";
  name: string;
  version: string;
  purl: string;
  hashes?: Array<{ alg: string; content: string }>;
  externalReferences?: Array<{ type: "distribution"; url: string }>;
  licenses?: Array<{ license: { name: string } }>;
  properties: Array<{ name: string; value: string }>;
}

export interface SbomDocument {
  bomFormat: "CycloneDX";
  specVersion: "1.6";
  serialNumber: string;
  version: 1;
  metadata: {
    component: {
      type: "application";
      "bom-ref": string;
      name: string;
      version: string;
    };
    properties: Array<{ name: string; value: string }>;
  };
  components: SbomComponent[];
}

export interface ReleaseProvenance {
  schemaVersion: string;
  generator: string;
  repositoryUrl: string | null;
  commitSha: string | null;
  commitDate: string | null;
  lockfileHash: string;
  sbomHash: string;
}

export interface SecretFinding {
  kind: "environment-value" | "secret-pattern";
  /** Env var name, or pattern name. Never a secret value. */
  identifier: string;
}

export interface IdentityCheck {
  failures: string[];
  unknownCount: number;
  totalCount: number;
}

export interface GateResult {
  passed: boolean;
  failures: string[];
  warnings: string[];
  summary: {
    components: number;
    unknownSources: number;
    secretFindings: number;
  };
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

/**
 * Deterministic pretty JSON for files committed to the repo: same sorted
 * keys as `stableStringify`, but 2-space indented so a lockfile change
 * diffs per component instead of rewriting one giant line.
 */
export function stablePrettyStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2);
}

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  const sorted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    sorted[k] = sortKeysDeep(v);
  }
  return sorted;
}

/** The lockfile's root package key is `""`. Every other key is a node_modules path. */
function packageNameFromKey(key: string): string | null {
  if (key === "") return null;
  const match = key.match(/node_modules\/((?:@[^/]+\/)?[^/]+)$/);
  return match ? match[1] : null;
}

/**
 * Classifies where a lockfile package claims to come from. A package with
 * no `resolved` URL has no recorded source at all — that is "unknown", not
 * "assumed npmjs", because the SBOM is meant to attest to provenance, not
 * to guess it. Only an https URL on an approved registry host counts as
 * known.
 */
export function classifySource(resolved?: string): SourceClassification {
  if (!resolved) {
    return {
      source: "unknown",
      host: null,
      reason: "no resolved URL recorded in lockfile",
    };
  }
  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    return { source: "unknown", host: null, reason: "unparseable resolved URL" };
  }
  if (url.protocol !== "https:") {
    return {
      source: "unknown",
      host: url.host || null,
      reason: `non-https source (${url.protocol})`,
    };
  }
  if (!KNOWN_SOURCE_HOSTS.has(url.host)) {
    return {
      source: "unknown",
      host: url.host,
      reason: `source host ${url.host} is not an approved registry`,
    };
  }
  return { source: "registry", host: url.host, reason: null };
}

/** `pkg:npm/<name>@<version>` with the scope `@` percent-encoded per purl spec. */
export function purlFor(name: string, version: string): string {
  const encodedName = name
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

/** Parses a lockfile `integrity` string (`sha512-<base64>`) into a CycloneDX hash entry. */
export function integrityToHash(
  integrity?: string,
): { alg: string; content: string } | null {
  if (!integrity) return null;
  const match = integrity.match(/^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  const alg = match[1].toUpperCase().replace("SHA", "SHA-");
  return { alg, content: match[2] };
}

/**
 * Builds the CycloneDX SBOM for the full lockfile tree (direct + transitive),
 * deduplicated by name@version and sorted by (name, version) so output is
 * byte-identical for a given lockfile. The `serialNumber` is derived from
 * the component list itself — no random UUID, no timestamp — so two builds
 * from the same lockfile are identical.
 */
export function buildSbom(
  pkg: PackageJson,
  lock: PackageLock,
  lockfileText: string,
): SbomDocument {
  const directRuntime = new Set(Object.keys(pkg.dependencies ?? {}));
  const directBuild = new Set(Object.keys(pkg.devDependencies ?? {}));

  const seen = new Map<string, SbomComponent>();

  for (const [key, entry] of Object.entries(lock.packages)) {
    const name = packageNameFromKey(key);
    if (!name) continue;
    const version = entry.version ?? "UNKNOWN";
    const dedupeKey = `${name}@${version}`;
    if (seen.has(dedupeKey)) continue;

    const classification = classifySource(entry.resolved);
    const hash = integrityToHash(entry.integrity);
    const category = directRuntime.has(name)
      ? "runtime"
      : directBuild.has(name)
        ? "build"
        : "transitive";

    const component: SbomComponent = {
      "bom-ref": purlFor(name, version),
      type: "library",
      name,
      version,
      purl: purlFor(name, version),
      properties: [
        { name: "earnproof:source", value: classification.source },
        {
          name: "earnproof:sourceHost",
          value: classification.host ?? "unrecorded",
        },
        { name: "earnproof:category", value: category },
      ],
    };
    if (hash) component.hashes = [hash];
    if (entry.resolved) {
      component.externalReferences = [
        { type: "distribution", url: entry.resolved },
      ];
    }
    if (entry.license) {
      component.licenses = [{ license: { name: entry.license } }];
    }
    seen.set(dedupeKey, component);
  }

  const components = [...seen.values()].sort((a, b) =>
    a.name === b.name
      ? a.version < b.version
        ? -1
        : a.version > b.version
          ? 1
          : 0
      : a.name < b.name
        ? -1
        : 1,
  );

  const serialHash = sha256Hex(stableStringify(components));
  const serialNumber =
    `urn:uuid:${serialHash.slice(0, 8)}-${serialHash.slice(8, 12)}-` +
    `${serialHash.slice(12, 16)}-${serialHash.slice(16, 20)}-${serialHash.slice(20, 32)}`;

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber,
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": purlFor(pkg.name, pkg.version),
        name: pkg.name,
        version: pkg.version,
      },
      properties: [
        { name: "earnproof:schemaVersion", value: SBOM_SCHEMA_VERSION },
        { name: "earnproof:lockfileHash", value: sha256Hex(lockfileText) },
        {
          name: "earnproof:lockfileVersion",
          value: String(lock.lockfileVersion),
        },
        { name: "earnproof:generator", value: SBOM_GENERATOR },
      ],
    },
    components,
  };
}

/**
 * True when a value is a URL with no embedded credentials — public
 * configuration (a registry URL, a docs URL), not a secret.
 */
function isPublicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/**
 * Secret patterns that must never appear in a published artifact. The
 * findings name the pattern (or the env var), never the matched value, so
 * a gate failure cannot itself leak the secret into CI logs.
 */
const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "private-key-header", regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "github-pat", regex: /github_pat_[A-Za-z0-9_]{10,}/ },
  { name: "github-token", regex: /\bgh[opaus]_[A-Za-z0-9]{20,}/ },
  { name: "openai-key", regex: /\bsk-[A-Za-z0-9]{16,}/ },
  { name: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "npm-token", regex: /\bnpm_[A-Za-z0-9]{20,}/ },
  {
    name: "credential-assignment",
    regex: /(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?[^\s"']{8,}/i,
  },
];

/**
 * Values the published artifacts intentionally contain, so an env var
 * holding one of them (or part of one) is not a leak: the package's own
 * name/version, the lockfile and SBOM hashes, and the provenance's commit
 * SHA, commit date, and repository URL. In CI these arrive as env vars
 * (`npm_package_name`, `GITHUB_SHA`, `GITHUB_REPOSITORY`, ...); flagging
 * them would fail every release for publishing exactly what provenance
 * is supposed to publish.
 */
export function publicArtifactValues(
  pkg: PackageJson,
  provenance: ReleaseProvenance | null,
  lockfileHash: string,
): Set<string> {
  const values = new Set<string>([pkg.name, pkg.version, lockfileHash]);
  if (provenance) {
    if (provenance.commitSha) values.add(provenance.commitSha);
    if (provenance.commitDate) values.add(provenance.commitDate);
    if (provenance.repositoryUrl) values.add(provenance.repositoryUrl);
    values.add(provenance.sbomHash);
    values.add(provenance.lockfileHash);
  }
  return values;
}

/**
 * Scans serialized artifact text for environment secrets. Two sources:
 * every current env var value long enough to be identifying, and generic
 * secret patterns. Short env values are skipped — a value like `true` or
 * `3000` appearing in an SBOM is not a leak, and flagging it would make
 * the scan unusable in any real CI environment. Values covered by
 * `allowlist` (see `publicArtifactValues`) are skipped for the same
 * reason: they are what the artifact is supposed to publish.
 */
export function scanForSecrets(
  text: string,
  env: NodeJS.ProcessEnv,
  allowlist: Set<string> = new Set(),
): SecretFinding[] {
  const findings: SecretFinding[] = [];

  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_SECRET_VALUE_LENGTH) continue;
    if ([...allowlist].some((pub) => pub.includes(value))) continue;
    // A bare URL with no credentials (e.g. npm_config_registry) is public
    // configuration, not a secret — and every resolved SBOM URL starts
    // with it, so flagging it would make the scan unusable. A URL carrying
    // userinfo (https://token@host) is still treated as a secret below.
    if (isPublicUrl(value)) continue;
    if (text.includes(value)) {
      findings.push({ kind: "environment-value", identifier: name });
    }
  }

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.regex.test(text)) {
      findings.push({ kind: "secret-pattern", identifier: pattern.name });
    }
  }

  return findings;
}

/**
 * Strips credentials from a repository URL (e.g. `https://token@github.com/...`)
 * before it is recorded as provenance. A remote URL is build metadata, not
 * a place to carry a token.
 */
export function sanitizeRepositoryUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url.replace(/:\/\/[^@]*@/, "://");
  }
}

/**
 * Builds the release provenance record tying the SBOM to its source and
 * build. Commit fields are optional (a tarball checkout has no git state)
 * but must appear together when present. Throws on malformed input rather
 * than recording provenance that does not check out.
 */
export function buildProvenance(input: {
  repositoryUrl?: string | null;
  commitSha?: string | null;
  commitDate?: string | null;
  lockfileHash: string;
  sbomHash: string;
}): ReleaseProvenance {
  const { commitSha = null, commitDate = null } = input;
  if ((commitSha === null) !== (commitDate === null)) {
    throw new Error("commitSha and commitDate must be provided together");
  }
  if (commitSha !== null && !/^[0-9a-f]{40}$/.test(commitSha)) {
    throw new Error("commitSha must be a 40-character lowercase hex SHA");
  }
  if (commitDate !== null && Number.isNaN(Date.parse(commitDate))) {
    throw new Error("commitDate must be an ISO 8601 timestamp");
  }
  if (!/^[0-9a-f]{64}$/.test(input.lockfileHash)) {
    throw new Error("lockfileHash must be a 64-character lowercase hex SHA-256");
  }
  if (!/^[0-9a-f]{64}$/.test(input.sbomHash)) {
    throw new Error("sbomHash must be a 64-character lowercase hex SHA-256");
  }

  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    generator: SBOM_GENERATOR,
    repositoryUrl: sanitizeRepositoryUrl(input.repositoryUrl ?? null),
    commitSha,
    commitDate,
    lockfileHash: input.lockfileHash,
    sbomHash: input.sbomHash,
  };
}

/** Bounds check: component count and serialized size caps. */
export function checkBounds(componentCount: number, byteLength: number): string[] {
  const failures: string[] = [];
  if (componentCount > MAX_COMPONENTS) {
    failures.push(
      `SBOM has ${componentCount} components, over the ${MAX_COMPONENTS} cap — ` +
        `the dependency tree grew past what a reviewable SBOM covers`,
    );
  }
  if (byteLength > MAX_SBOM_BYTES) {
    failures.push(
      `SBOM is ${byteLength} bytes, over the ${MAX_SBOM_BYTES} byte cap`,
    );
  }
  return failures;
}

/**
 * Validates package identities across the lockfile: every distinct
 * name@version must come from an approved registry host and, when a source
 * URL is recorded, must carry an integrity hash. Failures are capped so a
 * badly broken lockfile produces a readable report, not a log flood — the
 * counts still show the full scale.
 */
export function validatePackageIdentities(lock: PackageLock): IdentityCheck {
  const failures: string[] = [];
  const seen = new Set<string>();
  let unknownCount = 0;
  let totalCount = 0;

  for (const [key, entry] of Object.entries(lock.packages)) {
    const name = packageNameFromKey(key);
    if (!name) continue;
    const version = entry.version ?? "UNKNOWN";
    const dedupeKey = `${name}@${version}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    totalCount++;

    const classification = classifySource(entry.resolved);
    if (classification.source === "unknown") {
      unknownCount++;
      if (failures.length < MAX_LISTED_FAILURES) {
        failures.push(
          `unknown dependency source: ${dedupeKey} (${classification.reason})`,
        );
      }
      continue;
    }
    if (!integrityToHash(entry.integrity)) {
      if (failures.length < MAX_LISTED_FAILURES) {
        failures.push(
          `missing integrity hash: ${dedupeKey} (resolved from ${classification.host})`,
        );
      }
    }
  }

  if (unknownCount > MAX_LISTED_FAILURES) {
    failures.push(
      `... and ${unknownCount - MAX_LISTED_FAILURES} more unknown-source packages`,
    );
  }

  return { failures, unknownCount, totalCount };
}

function metadataProperty(
  sbom: SbomDocument,
  name: string,
): string | undefined {
  return sbom.metadata.properties.find((p) => p.name === name)?.value;
}

/**
 * The release gate. Re-derives the SBOM from the current lockfile and
 * checks, in order: the committed SBOM matches the regeneration (drift),
 * every package identity is known and hashed, no secret appears in the
 * SBOM or the provenance, the SBOM stays within its bounds, and the
 * provenance hashes match the lockfile and the SBOM on disk. A missing git
 * state is a warning, not a failure — a release built from a tarball has no
 * commit to attest to, and the provenance record says so explicitly.
 */
export function runReleaseGate(input: {
  pkg: PackageJson;
  lock: PackageLock;
  lockfileText: string;
  committedSbomText: string;
  provenance: ReleaseProvenance | null;
}): GateResult {
  const failures: string[] = [];
  const warnings: string[] = [];

  const regenerated = buildSbom(input.pkg, input.lock, input.lockfileText);
  const regeneratedText = `${stablePrettyStringify(regenerated)}\n`;

  if (input.committedSbomText !== regeneratedText) {
    failures.push(
      "committed sbom.cyclonedx.json is out of date with package.json / " +
        "package-lock.json — run `npm run sbom:publish` and commit the result",
    );
  }

  const identity = validatePackageIdentities(input.lock);
  failures.push(...identity.failures);

  const provenanceText = input.provenance
    ? `${stablePrettyStringify(input.provenance)}\n`
    : "";
  const lockfileHash = sha256Hex(input.lockfileText);
  const secretFindings = scanForSecrets(
    input.committedSbomText + provenanceText,
    process.env,
    publicArtifactValues(input.pkg, input.provenance, lockfileHash),
  );
  for (const finding of secretFindings) {
    failures.push(
      `secret detected in published artifact (${finding.kind}: ${finding.identifier}) — ` +
        `refusing to publish`,
    );
  }

  failures.push(
    ...checkBounds(
      regenerated.components.length,
      Buffer.byteLength(input.committedSbomText, "utf8"),
    ),
  );

  let committedSbom: SbomDocument | null = null;
  try {
    committedSbom = JSON.parse(input.committedSbomText) as SbomDocument;
  } catch {
    failures.push("committed sbom.cyclonedx.json is not valid JSON");
  }
  if (committedSbom) {
    if (metadataProperty(committedSbom, "earnproof:lockfileHash") !== lockfileHash) {
      failures.push(
        "SBOM lockfileHash does not match package-lock.json — the SBOM was " +
          "built from a different lockfile",
      );
    }
    if (input.provenance) {
      if (input.provenance.lockfileHash !== lockfileHash) {
        failures.push("provenance lockfileHash does not match package-lock.json");
      }
      if (input.provenance.sbomHash !== sha256Hex(input.committedSbomText)) {
        failures.push(
          "provenance sbomHash does not match scripts/sbom/sbom.cyclonedx.json",
        );
      }
    }
  }

  if (!input.provenance || !input.provenance.commitSha) {
    warnings.push(
      "no source commit recorded in provenance — release built without git state",
    );
  }

  return {
    passed: failures.length === 0,
    failures,
    warnings,
    summary: {
      components: regenerated.components.length,
      unknownSources: identity.unknownCount,
      secretFindings: secretFindings.length,
    },
  };
}

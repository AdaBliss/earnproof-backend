/**
 * Publishes the machine-readable SBOM and its release provenance.
 *
 * Writes two artifacts under scripts/sbom/:
 * - `sbom.cyclonedx.json` — the CycloneDX SBOM for the full lockfile tree.
 *   Committed: it is deterministic (same lockfile → byte-identical file),
 *   so the release gate can drift-check it like `inventory.md`.
 * - `provenance.json` — the release provenance record (source commit,
 *   lockfile hash, SBOM hash). NOT committed: it names the commit that
 *   produced it, so it is regenerated at release time by this script and
 *   uploaded by the release workflow. It is gitignored.
 *
 * The script records the truth about dependency sources — packages with no
 * recorded source are listed as `unknown` in the SBOM — and refuses to
 * write anything at all if a secret would leak into the output. Failing
 * the release on unknown sources is the release gate's job
 * (`sbom:release-gate`), not this script's: publish must be able to run
 * on a deficient lockfile so the deficiency is visible, not hidden.
 *
 * Run: npm run sbom:publish
 */
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  buildProvenance,
  buildSbom,
  publicArtifactValues,
  REPO_ROOT,
  readPackageJson,
  readPackageLock,
  scanForSecrets,
  sha256Hex,
  stablePrettyStringify,
  validatePackageIdentities,
  type ReleaseProvenance,
} from "./publish-lib";

const SBOM_PATH = join(REPO_ROOT, "scripts", "sbom", "sbom.cyclonedx.json");
const PROVENANCE_PATH = join(REPO_ROOT, "scripts", "sbom", "provenance.json");

function git(command: string): string | null {
  try {
    return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function main(): void {
  const pkg = readPackageJson();
  const lockText = readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8");
  const lock = readPackageLock();

  const sbom = buildSbom(pkg, lock, lockText);
  const sbomText = `${stablePrettyStringify(sbom)}\n`;

  // Never write an artifact that carries a secret. The scan names the env
  // var / pattern, never the value, so this output is safe to log.
  // The package's own name/version and the lockfile hash are what the SBOM
  // is supposed to publish, so they are allowlisted, not flagged.
  const secretFindings = scanForSecrets(
    sbomText,
    process.env,
    publicArtifactValues(pkg, null, sha256Hex(lockText)),
  );
  if (secretFindings.length > 0) {
    for (const finding of secretFindings) {
      console.error(`FAIL: secret detected in SBOM output (${finding.kind}: ${finding.identifier})`);
    }
    console.error("sbom:publish refused to write anything.");
    process.exit(1);
  }

  writeFileSync(SBOM_PATH, sbomText, "utf8");

  const provenance: ReleaseProvenance = buildProvenance({
    repositoryUrl: git("git config --get remote.origin.url"),
    commitSha: git("git rev-parse HEAD"),
    commitDate: git("git log -1 --format=%cI"),
    lockfileHash: sha256Hex(lockText),
    sbomHash: sha256Hex(sbomText),
  });
  writeFileSync(PROVENANCE_PATH, `${stablePrettyStringify(provenance)}\n`, "utf8");

  const identity = validatePackageIdentities(lock);
  console.log(
    `ok: wrote ${sbom.components.length} components to scripts/sbom/sbom.cyclonedx.json ` +
      `(serial ${sbom.serialNumber})`,
  );
  console.log(
    `ok: wrote release provenance to scripts/sbom/provenance.json ` +
      `(commit ${provenance.commitSha ?? "unavailable"}, lockfile ${provenance.lockfileHash.slice(0, 12)})`,
  );
  if (identity.unknownCount > 0) {
    console.warn(
      `warn: ${identity.unknownCount} of ${identity.totalCount} packages have an ` +
        `unknown source — the release gate will fail until the lockfile records ` +
        `a resolved URL and integrity hash for them (regenerate with npm install)`,
    );
    for (const failure of identity.failures.slice(0, 10)) {
      console.warn(`warn: ${failure}`);
    }
  } else {
    console.log(`ok: every package identity is known and hashed`);
  }
}

main();

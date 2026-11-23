/**
 * Release gate for the published SBOM.
 *
 * Fails (exit 1) when any of these hold:
 * - the committed `scripts/sbom/sbom.cyclonedx.json` does not match a fresh
 *   regeneration from the current lockfile (drift);
 * - any dependency source is unknown (no resolved URL, an unapproved
 *   registry host, or a non-https source) or a recorded source has no
 *   integrity hash;
 * - an environment secret or a secret pattern appears in the SBOM or the
 *   provenance;
 * - the SBOM is over its component-count or byte-size bounds;
 * - the provenance hashes do not match the lockfile and the SBOM on disk.
 *
 * Run in the release workflow before any artifact is uploaded, and locally
 * with: npm run sbom:release-gate
 */
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  buildProvenance,
  REPO_ROOT,
  readPackageJson,
  readPackageLock,
  runReleaseGate,
  sha256Hex,
  type ReleaseProvenance,
} from "./publish-lib";

const SBOM_PATH = join(REPO_ROOT, "scripts", "sbom", "sbom.cyclonedx.json");

function git(command: string): string | null {
  try {
    return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function main(): void {
  if (!existsSync(SBOM_PATH)) {
    console.error("FAIL: scripts/sbom/sbom.cyclonedx.json does not exist. Run `npm run sbom:publish`.");
    process.exit(1);
  }

  const pkg = readPackageJson();
  const lockText = readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8");
  const lock = readPackageLock();
  const committedSbomText = readFileSync(SBOM_PATH, "utf8");

  let provenance: ReleaseProvenance | null = null;
  try {
    provenance = buildProvenance({
      repositoryUrl: git("git config --get remote.origin.url"),
      commitSha: git("git rev-parse HEAD"),
      commitDate: git("git log -1 --format=%cI"),
      lockfileHash: sha256Hex(lockText),
      sbomHash: sha256Hex(committedSbomText),
    });
  } catch (error) {
    console.error(`FAIL: could not build release provenance: ${(error as Error).message}`);
    process.exit(1);
  }

  const result = runReleaseGate({
    pkg,
    lock,
    lockfileText: lockText,
    committedSbomText,
    provenance,
  });

  console.log(
    `ok: checked ${result.summary.components} SBOM components, ` +
      `${result.summary.unknownSources} unknown sources, ` +
      `${result.summary.secretFindings} secret findings`,
  );
  for (const warning of result.warnings) {
    console.warn(`warn: ${warning}`);
  }
  if (!result.passed) {
    for (const failure of result.failures) {
      console.error(`FAIL: ${failure}`);
    }
    console.error("\nsbom:release-gate failed.");
    process.exit(1);
  }

  console.log("\nsbom:release-gate passed.");
}

main();

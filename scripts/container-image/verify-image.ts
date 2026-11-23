/**
 * Deploy gate CLI for signed container images.
 *
 * Verifies, offline, that the image reference about to be deployed is
 * digest-pinned to the release the operator expects, and — when given a saved
 * provenance attestation bundle — that the attestation agrees with that
 * digest. Prints a machine-readable JSON decision and exits 0 only when
 * every check passes, so it composes with `set -e` deploy scripts and with
 * the release workflow's own verify step.
 *
 * This is the policy half of verification. It does not check signatures:
 * run `cosign verify` / `cosign verify-attestation` as documented in
 * docs/deployment.md for the cryptographic check.
 *
 * Usage:
 *   npm run image:verify -- --reference ghcr.io/veridatum-labs/earnproof-backend@sha256:<digest> \
 *     --expected-digest sha256:<digest> [--expected-tag v1.2.3] \
 *     [--provenance ./attestation.json --expected-source-ref refs/tags/v1.2.3]
 */
import { readFileSync } from "fs";
import {
  checkProvenance,
  verifyDeployReference,
  type DeployDecision,
  type ProvenanceAttestation,
  type ProvenanceDecision,
} from "./image-verification";

export interface VerifyCliOptions {
  reference: string;
  expectedDigest?: string;
  expectedTag?: string;
  provenancePath?: string;
  expectedSourceRef?: string;
}

const USAGE =
  "usage: npm run image:verify -- --reference <image>@<digest> [--expected-digest <digest>] [--expected-tag <tag>] [--provenance <attestation.json>] [--expected-source-ref <ref>]";

export function parseVerifyArgs(argv: readonly string[]): VerifyCliOptions {
  const options: VerifyCliOptions = { reference: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${USAGE}\nmissing value for '${flag}'`);
    }
    switch (flag) {
      case "--reference":
        options.reference = value;
        break;
      case "--expected-digest":
        options.expectedDigest = value;
        break;
      case "--expected-tag":
        options.expectedTag = value;
        break;
      case "--provenance":
        options.provenancePath = value;
        break;
      case "--expected-source-ref":
        options.expectedSourceRef = value;
        break;
      default:
        throw new Error(`${USAGE}\nunknown argument '${flag}'`);
    }
    i += 1;
  }
  if (options.reference === "") {
    throw new Error(`${USAGE}\n--reference is required`);
  }
  return options;
}

export interface VerifyCliResult {
  deploy: DeployDecision;
  provenance: ProvenanceDecision | null;
}

/**
 * Run the deploy gate. `readAttestation` is injectable so tests can supply
 * an attestation without touching the filesystem; the CLI passes a loader
 * that reads and parses the JSON file.
 */
export function runVerify(
  options: VerifyCliOptions,
  readAttestation: (path: string) => ProvenanceAttestation = (path) =>
    JSON.parse(readFileSync(path, "utf8")) as ProvenanceAttestation,
): VerifyCliResult {
  const deploy = verifyDeployReference({
    reference: options.reference,
    ...(options.expectedDigest !== undefined
      ? { expectedDigest: options.expectedDigest }
      : {}),
    ...(options.expectedTag !== undefined
      ? { expectedTag: options.expectedTag }
      : {}),
  });

  let provenance: ProvenanceDecision | null = null;
  if (options.provenancePath !== undefined) {
    if (!deploy.allowed || deploy.digest === undefined) {
      provenance = {
        allowed: false,
        code: "subject_digest_mismatch",
        reason:
          "provenance cannot be checked: the deploy reference was not verified",
      };
    } else {
      provenance = checkProvenance({
        attestation: readAttestation(options.provenancePath),
        expectedDigest: deploy.digest,
        ...(options.expectedSourceRef !== undefined
          ? { expectedSourceRef: options.expectedSourceRef }
          : {}),
      });
    }
  }

  return { deploy, provenance };
}

function main(): void {
  let options: VerifyCliOptions;
  try {
    options = parseVerifyArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }

  let result: VerifyCliResult;
  try {
    result = runVerify(options);
  } catch (error) {
    process.stderr.write(
      `image verification failed to run: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  const allowed =
    result.deploy.allowed &&
    (result.provenance === null || result.provenance.allowed);
  process.exit(allowed ? 0 : 1);
}

if (require.main === module) {
  main();
}

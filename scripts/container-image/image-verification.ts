/**
 * Container image verification policy for the EarnProof backend image.
 *
 * This module is the deploy-time gate behind "tags are never trusted without
 * digest verification": a deployment may only reference an image by its
 * content digest, published by the release workflow, and only after the
 * release's provenance attestation agrees with that digest.
 *
 * Deliberately pure and offline. It parses strings and compares digests; it
 * never contacts a registry, never shells out to cosign, and never reads a
 * credential. The release workflow performs the cryptographic steps (keyless
 * cosign signing and SLSA attestation verification) where the OIDC identity
 * exists; this module is what an operator runs before `docker run` so a
 * mistyped or tag-only reference fails here instead of in production.
 * Operators who need cryptographic verification run `cosign verify` and
 * `cosign verify-attestation` as documented in docs/deployment.md — those
 * commands, not this module, are the signature check.
 *
 * Run: npm run image:verify -- --reference <image>@<digest> [--expected-digest <digest>]
 */

export const IMAGE_REFERENCE_MAX_LENGTH = 512;
export const DIGEST_ALGORITHM = "sha256";
export const DIGEST_HEX_LENGTH = 64;

/** The only registry releases are published to. */
export const DEFAULT_REGISTRY = "ghcr.io";
/** The only repository releases are published to, without the registry. */
export const DEFAULT_REPOSITORY = "veridatum-labs/earnproof-backend";
/** Full image name releases are published under. */
export const DEFAULT_IMAGE = `${DEFAULT_REGISTRY}/${DEFAULT_REPOSITORY}`;
/** Source repository the provenance attestation must name. */
export const DEFAULT_SOURCE_REPOSITORY =
  "https://github.com/veridatum-labs/earnproof-backend";
/**
 * Builder id recorded by the GitHub Actions provenance attestation
 * (actions/attest-build-provenance). The release workflow's cosign
 * verification checks the same identity cryptographically; this is the
 * plaintext half of that check, for the deploy gate.
 */
export const DEFAULT_BUILDER_ID = "https://github.com/actions/runner";
/** Workflow that is allowed to have produced a releasable image. */
export const DEFAULT_WORKFLOW_PATH = ".github/workflows/release-image.yml";
/** OIDC issuer cosign verification pins the signing certificate to. */
export const DEFAULT_CERTIFICATE_ISSUER =
  "https://token.actions.githubusercontent.com";
/** SLSA provenance predicate types the release workflow can produce. */
export const SLSA_PROVENANCE_PREDICATE_TYPES: ReadonlySet<string> = new Set([
  "https://slsa.dev/provenance/v1",
  "https://slsa.dev/provenance/v0.2",
]);

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ALGORITHM_PREFIX_PATTERN = /^([a-z][a-z0-9]*):(.*)$/;
const TAG_PATTERN = /^[\w][\w.-]{0,127}$/;
const REGISTRY_PATTERN = /^[a-z0-9][a-z0-9.-]*(:[0-9]{1,5})?$/;
const REPOSITORY_COMPONENT_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/**
 * Whitespace or control characters. Checked by code point rather than a
 * regex: a character class naming control ranges trips the linter's
 * no-control-regex rule, and this reads no worse.
 */
function hasInvalidReferenceCharacters(reference: string): boolean {
  for (const ch of reference) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || /\s/.test(ch)) {
      return true;
    }
  }
  return false;
}

export type ImageReferenceErrorCode =
  | "empty_reference"
  | "reference_too_long"
  | "invalid_characters"
  | "contains_scheme"
  | "multiple_digests"
  | "missing_registry"
  | "invalid_registry"
  | "invalid_repository"
  | "invalid_tag"
  | "mutable_tag_latest"
  | "unsupported_algorithm"
  | "malformed_digest";

export class ImageReferenceError extends Error {
  readonly code: ImageReferenceErrorCode;

  constructor(code: ImageReferenceErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ImageReferenceError";
    this.code = code;
  }
}

export interface ParsedImageReference {
  registry: string;
  repository: string;
  /** Tag, when the reference carries one. Never "latest" — see parseImageReference. */
  tag?: string;
  /** Full digest ("sha256:<64 hex>"), when the reference carries one. */
  digest?: string;
  /** Canonical form: registry/repository[:tag][@digest]. */
  canonical: string;
}

/**
 * Parse an image reference into its parts. Strict by design:
 *
 * - the registry must be explicit (no implicit Docker Hub default — an
 *   omitted registry is how a deploy silently resolves to the wrong host);
 * - the digest, when present, must be lowercase `sha256:` plus exactly 64
 *   hex characters (canonical form only, so two spellings of one image
 *   cannot compare unequal);
 * - the tag `latest` is rejected even with a digest: a mutable tag next to a
 *   digest invites someone to drop the digest later and keep deploying.
 *
 * A reference without a digest parses successfully — the deploy decision in
 * verifyDeployReference is what rejects it. Parsing and policy are separate
 * so callers can distinguish "not well-formed" from "well-formed but not
 * deployable".
 */
export function parseImageReference(reference: unknown): ParsedImageReference {
  if (typeof reference !== "string" || reference.length === 0) {
    throw new ImageReferenceError(
      "empty_reference",
      "image reference must be a non-empty string",
    );
  }
  if (reference.length > IMAGE_REFERENCE_MAX_LENGTH) {
    throw new ImageReferenceError(
      "reference_too_long",
      `image reference is ${reference.length} characters, max ${IMAGE_REFERENCE_MAX_LENGTH}`,
    );
  }
  if (hasInvalidReferenceCharacters(reference)) {
    throw new ImageReferenceError(
      "invalid_characters",
      "image reference must not contain whitespace or control characters",
    );
  }
  if (reference.includes("://")) {
    throw new ImageReferenceError(
      "contains_scheme",
      "image reference must not contain a URL scheme",
    );
  }

  const atParts = reference.split("@");
  if (atParts.length > 2) {
    throw new ImageReferenceError(
      "multiple_digests",
      "image reference must contain at most one '@' digest separator",
    );
  }
  const [namePart, digestPart] = atParts;

  let digest: string | undefined;
  if (digestPart !== undefined) {
    const algorithm = ALGORITHM_PREFIX_PATTERN.exec(digestPart);
    if (!algorithm || algorithm[1] !== DIGEST_ALGORITHM) {
      throw new ImageReferenceError(
        "unsupported_algorithm",
        `only ${DIGEST_ALGORITHM} digests are accepted, got '${digestPart.split(":")[0] || ""}'`,
      );
    }
    if (!DIGEST_PATTERN.test(digestPart)) {
      throw new ImageReferenceError(
        "malformed_digest",
        "digest must be 'sha256:' followed by exactly 64 lowercase hex characters",
      );
    }
    digest = digestPart;
  }

  // The tag is the part after the last ':' that follows the last '/'.
  let name = namePart;
  let tag: string | undefined;
  const lastSlash = namePart.lastIndexOf("/");
  const lastColon = namePart.lastIndexOf(":");
  if (lastColon > lastSlash) {
    tag = namePart.slice(lastColon + 1);
    name = namePart.slice(0, lastColon);
    if (!TAG_PATTERN.test(tag)) {
      throw new ImageReferenceError(
        "invalid_tag",
        `tag '${tag}' must start with a word character and be at most 128 characters`,
      );
    }
    if (tag === "latest") {
      throw new ImageReferenceError(
        "mutable_tag_latest",
        "the 'latest' tag is mutable and is never a deployable reference",
      );
    }
  }

  const components = name.split("/");
  if (components.length < 2) {
    throw new ImageReferenceError(
      "missing_registry",
      "image reference must name its registry explicitly (e.g. 'ghcr.io/...')",
    );
  }
  const [registry, ...repositoryParts] = components;
  if (
    !REGISTRY_PATTERN.test(registry) ||
    registry.includes("..") ||
    registry.startsWith(".") ||
    registry.endsWith(".") ||
    registry.startsWith("-") ||
    registry.endsWith("-") ||
    (!registry.includes(".") && !registry.includes(":") && registry !== "localhost")
  ) {
    throw new ImageReferenceError(
      "invalid_registry",
      `registry '${registry}' is not a valid lowercase registry host`,
    );
  }
  if (
    repositoryParts.some(
      (part) => !REPOSITORY_COMPONENT_PATTERN.test(part),
    ) ||
    name.length > 255
  ) {
    throw new ImageReferenceError(
      "invalid_repository",
      `repository '${repositoryParts.join("/")}' must be lowercase dot/dash/underscore-separated path components`,
    );
  }
  const repository = repositoryParts.join("/");

  return {
    registry,
    repository,
    ...(tag !== undefined ? { tag } : {}),
    ...(digest !== undefined ? { digest } : {}),
    canonical: `${registry}/${repository}${tag !== undefined ? `:${tag}` : ""}${
      digest !== undefined ? `@${digest}` : ""
    }`,
  };
}

export type DeployDecisionCode =
  | "ok"
  | "invalid_reference"
  | "registry_not_allowed"
  | "repository_mismatch"
  | "missing_digest"
  | "invalid_expected_digest"
  | "digest_mismatch"
  | "tag_mismatch";

export interface DeployReferenceInput {
  reference: string;
  /**
   * Digest the release recorded for this deploy (e.g. from the release
   * workflow's `image-digest.txt` artifact). When given, the reference's
   * digest must equal it exactly.
   */
  expectedDigest?: string;
  /** Tag the deploy is expected to be (e.g. "v1.2.3"). When given, the reference must carry it. */
  expectedTag?: string;
  allowedRegistries?: readonly string[];
  expectedRepository?: string;
}

export interface DeployDecision {
  allowed: boolean;
  code: DeployDecisionCode;
  reason: string;
  /** Canonical digest-pinned reference, present only when allowed. */
  reference?: string;
  digest?: string;
}

function deny(code: DeployDecisionCode, reason: string): DeployDecision {
  return { allowed: false, code, reason };
}

/**
 * Decide whether an image reference may be deployed. Fail-closed: any
 * unparseable input, any registry or repository outside the allowlist, any
 * reference without a digest, and any digest or tag that disagrees with the
 * expected values is denied. A bare tag can never be allowed — there is no
 * code path that returns `allowed: true` without a digest.
 */
export function verifyDeployReference(
  input: DeployReferenceInput,
): DeployDecision {
  let parsed: ParsedImageReference;
  try {
    parsed = parseImageReference(input.reference);
  } catch (error) {
    if (error instanceof ImageReferenceError) {
      return deny("invalid_reference", error.message);
    }
    throw error;
  }

  const allowedRegistries = input.allowedRegistries ?? [DEFAULT_REGISTRY];
  if (!allowedRegistries.includes(parsed.registry)) {
    return deny(
      "registry_not_allowed",
      `registry '${parsed.registry}' is not in the allowed list (${allowedRegistries.join(", ")})`,
    );
  }

  const expectedRepository = input.expectedRepository ?? DEFAULT_REPOSITORY;
  if (parsed.repository !== expectedRepository) {
    return deny(
      "repository_mismatch",
      `repository '${parsed.repository}' does not match the expected '${expectedRepository}'`,
    );
  }

  if (parsed.digest === undefined) {
    return deny(
      "missing_digest",
      "tags are never trusted without a digest: deploy by 'registry/repository@sha256:<digest>'",
    );
  }

  if (input.expectedDigest !== undefined) {
    if (!DIGEST_PATTERN.test(input.expectedDigest)) {
      return deny(
        "invalid_expected_digest",
        "expected digest must be 'sha256:' followed by exactly 64 lowercase hex characters",
      );
    }
    if (parsed.digest !== input.expectedDigest) {
      return deny(
        "digest_mismatch",
        `reference digest does not match the expected digest '${input.expectedDigest}'`,
      );
    }
  }

  if (input.expectedTag !== undefined) {
    if (parsed.tag !== input.expectedTag) {
      return deny(
        "tag_mismatch",
        `reference tag '${parsed.tag ?? "(none)"}' does not match the expected tag '${input.expectedTag}'`,
      );
    }
  }

  return {
    allowed: true,
    code: "ok",
    reason: `digest-pinned reference verified for ${parsed.registry}/${parsed.repository}`,
    reference: parsed.canonical,
    digest: parsed.digest,
  };
}

export type ProvenanceDecisionCode =
  | "ok"
  | "malformed_attestation"
  | "invalid_predicate_type"
  | "builder_mismatch"
  | "source_repository_mismatch"
  | "source_ref_mismatch"
  | "subject_digest_mismatch"
  | "workflow_mismatch";

export interface ProvenanceAttestation {
  /** SLSA predicate type, e.g. "https://slsa.dev/provenance/v1". */
  predicateType: unknown;
  /** Builder id recorded in the attestation. */
  builderId: unknown;
  /** Source repository, e.g. "https://github.com/veridatum-labs/earnproof-backend". */
  sourceRepository: unknown;
  /** Source ref, e.g. "refs/tags/v1.2.3". */
  sourceRef: unknown;
  /** Digest of the image subject, "sha256:<64 hex>". */
  subjectDigest: unknown;
  /** Workflow path recorded in the attestation, when present. */
  workflowPath?: unknown;
}

export interface ProvenanceCheckInput {
  attestation: ProvenanceAttestation;
  /** Digest the deployed image must have. */
  expectedDigest: string;
  expectedSourceRepository?: string;
  /** When given, the attestation's source ref must equal it. */
  expectedSourceRef?: string;
  expectedBuilderId?: string;
  /** When given, the attestation's workflow path must equal it. */
  expectedWorkflowPath?: string;
}

export interface ProvenanceDecision {
  allowed: boolean;
  code: ProvenanceDecisionCode;
  reason: string;
}

/**
 * Check a SLSA provenance attestation (already parsed from JSON — this
 * function does no I/O) against the image being deployed. Every field is
 * compared exactly; a missing or mistyped field denies, it never defaults
 * to allowed. This is the plaintext half of the release workflow's
 * `cosign verify-attestation` step: it lets an operator confirm the saved
 * attestation bundle agrees with the digest about to be deployed, without
 * needing the signing identity.
 */
export function checkProvenance(input: ProvenanceCheckInput): ProvenanceDecision {
  const { attestation } = input;
  const denyProvenance = (
    code: ProvenanceDecisionCode,
    reason: string,
  ): ProvenanceDecision => ({ allowed: false, code, reason });

  if (
    typeof attestation !== "object" ||
    attestation === null ||
    typeof attestation.predicateType !== "string" ||
    typeof attestation.builderId !== "string" ||
    typeof attestation.sourceRepository !== "string" ||
    typeof attestation.sourceRef !== "string" ||
    typeof attestation.subjectDigest !== "string"
  ) {
    return denyProvenance(
      "malformed_attestation",
      "attestation must carry string predicateType, builderId, sourceRepository, sourceRef and subjectDigest",
    );
  }

  if (!SLSA_PROVENANCE_PREDICATE_TYPES.has(attestation.predicateType)) {
    return denyProvenance(
      "invalid_predicate_type",
      `predicate type '${attestation.predicateType}' is not a recognised SLSA provenance predicate`,
    );
  }

  const expectedBuilderId = input.expectedBuilderId ?? DEFAULT_BUILDER_ID;
  if (attestation.builderId !== expectedBuilderId) {
    return denyProvenance(
      "builder_mismatch",
      `builder '${attestation.builderId}' does not match the expected '${expectedBuilderId}'`,
    );
  }

  const expectedSourceRepository =
    input.expectedSourceRepository ?? DEFAULT_SOURCE_REPOSITORY;
  if (attestation.sourceRepository !== expectedSourceRepository) {
    return denyProvenance(
      "source_repository_mismatch",
      `source repository '${attestation.sourceRepository}' does not match the expected '${expectedSourceRepository}'`,
    );
  }

  if (
    input.expectedSourceRef !== undefined &&
    attestation.sourceRef !== input.expectedSourceRef
  ) {
    return denyProvenance(
      "source_ref_mismatch",
      `source ref '${attestation.sourceRef}' does not match the expected '${input.expectedSourceRef}'`,
    );
  }

  if (!DIGEST_PATTERN.test(input.expectedDigest)) {
    return denyProvenance(
      "subject_digest_mismatch",
      "expected digest must be 'sha256:' followed by exactly 64 lowercase hex characters",
    );
  }
  if (attestation.subjectDigest !== input.expectedDigest) {
    return denyProvenance(
      "subject_digest_mismatch",
      "attestation subject digest does not match the digest being deployed",
    );
  }

  if (
    input.expectedWorkflowPath !== undefined &&
    attestation.workflowPath !== input.expectedWorkflowPath
  ) {
    return denyProvenance(
      "workflow_mismatch",
      `workflow '${String(attestation.workflowPath ?? "(none)")}' does not match the expected '${input.expectedWorkflowPath}'`,
    );
  }

  return {
    allowed: true,
    code: "ok",
    reason: `provenance attestation verified for ${attestation.sourceRef} at ${attestation.subjectDigest}`,
  };
}

import { readFileSync } from "fs";
import { join } from "path";
import {
  IMAGE_REFERENCE_MAX_LENGTH,
  checkProvenance,
  parseImageReference,
  verifyDeployReference,
  ImageReferenceError,
  type ProvenanceAttestation,
  type ProvenanceCheckInput,
} from "./image-verification";
import { parseVerifyArgs, runVerify } from "./verify-image";

const DIGEST = `sha256:${"ab".repeat(32)}`;
const OTHER_DIGEST = `sha256:${"cd".repeat(32)}`;
const IMAGE = "ghcr.io/veridatum-labs/earnproof-backend";
const PINNED = `${IMAGE}@${DIGEST}`;
const TAGGED_PINNED = `${IMAGE}:v1.2.3@${DIGEST}`;

function validAttestation(
  overrides: Partial<ProvenanceAttestation> = {},
): ProvenanceAttestation {
  return {
    predicateType: "https://slsa.dev/provenance/v1",
    builderId: "https://github.com/actions/runner",
    sourceRepository: "https://github.com/veridatum-labs/earnproof-backend",
    sourceRef: "refs/tags/v1.2.3",
    subjectDigest: DIGEST,
    workflowPath: ".github/workflows/release-image.yml",
    ...overrides,
  };
}

describe("parseImageReference", () => {
  it("parses a digest-pinned reference", () => {
    expect(parseImageReference(PINNED)).toEqual({
      registry: "ghcr.io",
      repository: "veridatum-labs/earnproof-backend",
      digest: DIGEST,
      canonical: PINNED,
    });
  });

  it("parses a tag-plus-digest reference", () => {
    const parsed = parseImageReference(TAGGED_PINNED);
    expect(parsed.tag).toBe("v1.2.3");
    expect(parsed.digest).toBe(DIGEST);
    expect(parsed.canonical).toBe(TAGGED_PINNED);
  });

  it("parses a bare tag (policy, not parsing, rejects it)", () => {
    expect(parseImageReference(`${IMAGE}:v1.2.3`).tag).toBe("v1.2.3");
  });

  it("rejects the mutable 'latest' tag even with a digest", () => {
    expect(() => parseImageReference(`${IMAGE}:latest@${DIGEST}`)).toThrow(
      expect.objectContaining({
        code: "mutable_tag_latest",
      } as Partial<ImageReferenceError>),
    );
  });

  it("rejects a digest with the wrong algorithm", () => {
    expect(() =>
      parseImageReference(`${IMAGE}@sha512:${"ab".repeat(64)}`),
    ).toThrow(
      expect.objectContaining({ code: "unsupported_algorithm" }),
    );
  });

  it("rejects a short digest and an uppercase digest", () => {
    expect(() =>
      parseImageReference(`${IMAGE}@sha256:${"ab".repeat(31)}`),
    ).toThrow(expect.objectContaining({ code: "malformed_digest" }));
    expect(() =>
      parseImageReference(`${IMAGE}@sha256:${"AB".repeat(32)}`),
    ).toThrow(expect.objectContaining({ code: "malformed_digest" }));
  });

  it("rejects a reference with no explicit registry", () => {
    expect(() => parseImageReference(`earnproof-backend@${DIGEST}`)).toThrow(
      expect.objectContaining({ code: "missing_registry" }),
    );
  });

  it("rejects a scheme, whitespace and a second digest separator", () => {
    expect(() =>
      parseImageReference(`https://ghcr.io/foo@${DIGEST}`),
    ).toThrow(expect.objectContaining({ code: "contains_scheme" }));
    expect(() => parseImageReference(`${PINNED} `)).toThrow(
      expect.objectContaining({ code: "invalid_characters" }),
    );
    expect(() => parseImageReference(`${PINNED}@${DIGEST}`)).toThrow(
      expect.objectContaining({ code: "multiple_digests" }),
    );
  });

  it("rejects an uppercase repository and an empty reference", () => {
    expect(() =>
      parseImageReference(`ghcr.io/Veridatum-Labs/earnproof-backend@${DIGEST}`),
    ).toThrow(expect.objectContaining({ code: "invalid_repository" }));
    expect(() => parseImageReference("")).toThrow(
      expect.objectContaining({ code: "empty_reference" }),
    );
  });

  it("rejects a reference one character over the length bound", () => {
    const tooLong = `${IMAGE}@${DIGEST}` + "x".repeat(
      IMAGE_REFERENCE_MAX_LENGTH - `${IMAGE}@${DIGEST}`.length + 1,
    );
    expect(tooLong.length).toBe(IMAGE_REFERENCE_MAX_LENGTH + 1);
    expect(() => parseImageReference(tooLong)).toThrow(
      expect.objectContaining({ code: "reference_too_long" }),
    );
  });
});

describe("verifyDeployReference", () => {
  it("allows a digest-pinned reference for the release image", () => {
    const decision = verifyDeployReference({ reference: PINNED });
    expect(decision).toEqual({
      allowed: true,
      code: "ok",
      reason: expect.stringContaining("digest-pinned"),
      reference: PINNED,
      digest: DIGEST,
    });
  });

  it("allows a tag-plus-digest reference when both agree with expectations", () => {
    const decision = verifyDeployReference({
      reference: TAGGED_PINNED,
      expectedDigest: DIGEST,
      expectedTag: "v1.2.3",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reference).toBe(TAGGED_PINNED);
  });

  it("denies a bare tag: tags are never trusted without a digest", () => {
    expect(
      verifyDeployReference({ reference: `${IMAGE}:v1.2.3` }),
    ).toEqual(
      expect.objectContaining({ allowed: false, code: "missing_digest" }),
    );
  });

  it("denies an unlisted registry and a different repository", () => {
    expect(
      verifyDeployReference({
        reference: `docker.io/veridatum-labs/earnproof-backend@${DIGEST}`,
      }),
    ).toEqual(
      expect.objectContaining({ allowed: false, code: "registry_not_allowed" }),
    );
    expect(
      verifyDeployReference({
        reference: `ghcr.io/veridatum-labs/other-service@${DIGEST}`,
      }),
    ).toEqual(
      expect.objectContaining({ allowed: false, code: "repository_mismatch" }),
    );
  });

  it("denies a digest that disagrees with the expected digest", () => {
    expect(
      verifyDeployReference({
        reference: PINNED,
        expectedDigest: OTHER_DIGEST,
      }),
    ).toEqual(
      expect.objectContaining({ allowed: false, code: "digest_mismatch" }),
    );
  });

  it("denies a malformed expected digest instead of comparing against it", () => {
    expect(
      verifyDeployReference({
        reference: PINNED,
        expectedDigest: "sha256:short",
      }),
    ).toEqual(
      expect.objectContaining({
        allowed: false,
        code: "invalid_expected_digest",
      }),
    );
  });

  it("denies a tag mismatch and a tagless reference when a tag is expected", () => {
    expect(
      verifyDeployReference({
        reference: TAGGED_PINNED,
        expectedTag: "v1.2.4",
      }),
    ).toEqual(
      expect.objectContaining({ allowed: false, code: "tag_mismatch" }),
    );
    expect(
      verifyDeployReference({ reference: PINNED, expectedTag: "v1.2.3" }),
    ).toEqual(
      expect.objectContaining({ allowed: false, code: "tag_mismatch" }),
    );
  });

  it("denies an unparseable reference with the parse code preserved", () => {
    expect(verifyDeployReference({ reference: "not an image ref" })).toEqual(
      expect.objectContaining({ allowed: false, code: "invalid_reference" }),
    );
  });
});

describe("checkProvenance", () => {
  it("allows a matching SLSA v1 attestation", () => {
    expect(
      checkProvenance({
        attestation: validAttestation(),
        expectedDigest: DIGEST,
        expectedSourceRef: "refs/tags/v1.2.3",
        expectedWorkflowPath: ".github/workflows/release-image.yml",
      }),
    ).toEqual(
      expect.objectContaining({ allowed: true, code: "ok" }),
    );
  });

  it("allows the v0.2 predicate type as well", () => {
    expect(
      checkProvenance({
        attestation: validAttestation({
          predicateType: "https://slsa.dev/provenance/v0.2",
        }),
        expectedDigest: DIGEST,
      }),
    ).toEqual(expect.objectContaining({ allowed: true, code: "ok" }));
  });

  it("denies an unknown predicate type and a wrong builder", () => {
    expect(
      checkProvenance({
        attestation: validAttestation({
          predicateType: "https://example.com/provenance",
        }),
        expectedDigest: DIGEST,
      }),
    ).toEqual(
      expect.objectContaining({
        allowed: false,
        code: "invalid_predicate_type",
      }),
    );
    expect(
      checkProvenance({
        attestation: validAttestation({
          builderId: "https://example.com/builder",
        }),
        expectedDigest: DIGEST,
      }),
    ).toEqual(
      expect.objectContaining({ allowed: false, code: "builder_mismatch" }),
    );
  });

  it("denies a different source repository, source ref or subject digest", () => {
    expect(
      checkProvenance({
        attestation: validAttestation({
          sourceRepository: "https://github.com/veridatum-labs/other",
        }),
        expectedDigest: DIGEST,
      }),
    ).toEqual(
      expect.objectContaining({
        allowed: false,
        code: "source_repository_mismatch",
      }),
    );
    expect(
      checkProvenance({
        attestation: validAttestation(),
        expectedDigest: DIGEST,
        expectedSourceRef: "refs/tags/v1.2.4",
      }),
    ).toEqual(
      expect.objectContaining({
        allowed: false,
        code: "source_ref_mismatch",
      }),
    );
    expect(
      checkProvenance({
        attestation: validAttestation({ subjectDigest: OTHER_DIGEST }),
        expectedDigest: DIGEST,
      }),
    ).toEqual(
      expect.objectContaining({
        allowed: false,
        code: "subject_digest_mismatch",
      }),
    );
  });

  it("denies a workflow that is not the release workflow", () => {
    expect(
      checkProvenance({
        attestation: validAttestation({
          workflowPath: ".github/workflows/ci.yml",
        }),
        expectedDigest: DIGEST,
        expectedWorkflowPath: ".github/workflows/release-image.yml",
      }),
    ).toEqual(
      expect.objectContaining({ allowed: false, code: "workflow_mismatch" }),
    );
  });

  it("denies a malformed attestation instead of defaulting to allowed", () => {
    expect(
      checkProvenance({
        attestation: { predicateType: "https://slsa.dev/provenance/v1" },
        expectedDigest: DIGEST,
      } as unknown as ProvenanceCheckInput),
    ).toEqual(
      expect.objectContaining({
        allowed: false,
        code: "malformed_attestation",
      }),
    );
    expect(
      checkProvenance({
        attestation: validAttestation({ subjectDigest: 42 }),
        expectedDigest: DIGEST,
      }),
    ).toEqual(
      expect.objectContaining({
        allowed: false,
        code: "malformed_attestation",
      }),
    );
  });
});

describe("verify-image CLI", () => {
  it("parses the documented flags", () => {
    expect(
      parseVerifyArgs([
        "--reference",
        PINNED,
        "--expected-digest",
        DIGEST,
        "--expected-tag",
        "v1.2.3",
        "--provenance",
        "./attestation.json",
        "--expected-source-ref",
        "refs/tags/v1.2.3",
      ]),
    ).toEqual({
      reference: PINNED,
      expectedDigest: DIGEST,
      expectedTag: "v1.2.3",
      provenancePath: "./attestation.json",
      expectedSourceRef: "refs/tags/v1.2.3",
    });
  });

  it("rejects an unknown flag, a missing value and a missing --reference", () => {
    expect(() => parseVerifyArgs(["--nope", "x"])).toThrow(/unknown argument/);
    expect(() => parseVerifyArgs(["--reference"])).toThrow(/missing value/);
    expect(() => parseVerifyArgs([])).toThrow(/--reference is required/);
  });

  it("combines the deploy and provenance decisions", () => {
    const result = runVerify(
      {
        reference: TAGGED_PINNED,
        expectedDigest: DIGEST,
        expectedTag: "v1.2.3",
        provenancePath: "./attestation.json",
        expectedSourceRef: "refs/tags/v1.2.3",
      },
      () => validAttestation(),
    );
    expect(result.deploy.allowed).toBe(true);
    expect(result.provenance).toEqual(
      expect.objectContaining({ allowed: true, code: "ok" }),
    );
  });

  it("does not check provenance when the deploy reference itself is denied", () => {
    let loaderCalled = false;
    const result = runVerify(
      { reference: `${IMAGE}:v1.2.3`, provenancePath: "./attestation.json" },
      () => {
        loaderCalled = true;
        return validAttestation();
      },
    );
    expect(result.deploy.allowed).toBe(false);
    expect(result.provenance?.allowed).toBe(false);
    expect(loaderCalled).toBe(false);
  });
});

describe("release workflow regression guards", () => {
  const workflowPath = join(
    process.cwd(),
    ".github",
    "workflows",
    "release-image.yml",
  );
  const workflow = readFileSync(workflowPath, "utf8");

  it("never runs for a pull request, so signing credentials are unreachable from PRs", () => {
    expect(workflow).not.toContain("pull_request");
    expect(workflow).toContain("environment: release");
    expect(workflow).toContain("id-token: write");
  });

  it("signs and verifies in the same run and gates the deploy on the pinned reference", () => {
    expect(workflow).toContain("cosign sign");
    expect(workflow).toContain("cosign verify");
    expect(workflow).toContain("cosign verify-attestation");
    expect(workflow).toContain("attest-build-provenance");
    expect(workflow).toContain("npm run image:verify");
    expect(workflow).toContain("image-digest.txt");
  });

  it("uses no long-lived secret besides the ephemeral job token", () => {
    const secretRefs = workflow.match(/secrets\.[A-Z_]+/g) ?? [];
    expect(secretRefs.length).toBeGreaterThan(0);
    expect(secretRefs.every((ref) => ref === "secrets.GITHUB_TOKEN")).toBe(
      true,
    );
  });

  it("publishes no mutable 'latest' tag", () => {
    expect(workflow).not.toContain("value=latest");
    expect(workflow).not.toContain("type=raw,value=latest");
  });

  it("gates the deploy on a tag-and-digest reference, the only form the gate accepts with --expected-tag", () => {
    // A tagless reference with --expected-tag is denied (tag_mismatch), so
    // the workflow must pass "${IMAGE}:${RELEASE_TAG}@${IMAGE_DIGEST}" —
    // a gate step that passed "${IMAGE}@${IMAGE_DIGEST}" would fail every
    // release after signing.
    expect(workflow).toContain(
      '--reference "${IMAGE}:${RELEASE_TAG}@${IMAGE_DIGEST}"',
    );
  });

  it("labels the image with its source repository", () => {
    const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");
    expect(dockerfile).toContain(
      "org.opencontainers.image.source",
    );
    expect(dockerfile).toContain(
      "https://github.com/veridatum-labs/earnproof-backend",
    );
  });
});

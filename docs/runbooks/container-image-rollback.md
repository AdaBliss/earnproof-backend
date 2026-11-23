# Container image rollback

How to move production back to a previous backend image when the current one
is bad — a failed deploy, a bad release, or a signature/provenance check that
no longer passes.

The rule that governs the whole procedure: **a rollback deploys a signed
digest, never a tag.** Rolling back to `v1.2.3` because "that tag was fine
yesterday" reintroduces exactly the ambiguity signing exists to remove — a
tag can be re-pointed, a digest cannot. Every step below re-verifies the
target before anything runs it.

## Severity and owner

| Severity | Scenario | Response window |
|---|---|---|
| **S1** | Production is serving the bad image now | Immediate |
| **S2** | The bad image is staged but not yet serving traffic | Before it is promoted |
| **S3** | A release failed verification and published nothing | Next deploy window; nothing is running the bad image |

Owner: whoever holds the deploy. The `release` environment's required
reviewers do not gate a rollback — a rollback re-deploys an image that was
already reviewed and signed — but the verification steps below are not
skippable by the operator.

## Before you roll back

1. **Confirm the problem is the image, not the data.** If a migration has
   already applied against the new schema, rolling the image back can leave
   the old code talking to a new schema. Check the pre-deploy migration job
   first; if migrations applied, see [failed migration](failed-migration.md)
   before touching the image. An image rollback never reverses a migration.
2. **Do not rebuild.** A rebuild produces a new digest that no release
   signed. Rollback reuses a published digest.

## Diagnose

1. **Identify the last known-good digest.** In order of preference:
   - The deploy log for the previous successful deploy (it records the
     pinned reference the gate accepted).
   - The previous release's `image-digest.txt` artifact (90-day retention,
     named `image-digest-<tag>` on the release run).
   - `ghcr.io/veridatum-labs/earnproof-backend` in the registry, matching
     the previous tag — then confirm the digest against the release artifact
     before trusting it; the registry listing alone is not the record.
2. **Confirm the target release is the one you think it is.** The digest
   must belong to the previous version tag, not to a rebuild or a different
   branch. The attestation's source ref names the tag; check it in the next
   step.

## Mitigate

Run every command with the target digest substituted for `<digest>` and the
target tag for `<tag>`. Stop at the first failure — a rollback that skips a
failing verification is a second incident.

1. **Verify the signature and attestation** for the target digest, exactly
   as in [deployment](../deployment.md#verifying-a-published-image):

   ```bash
   IMAGE=ghcr.io/veridatum-labs/earnproof-backend
   DIGEST=sha256:<digest of the last known-good release>
   TAG=v<previous version>

   cosign verify \
     --certificate-identity "https://github.com/veridatum-labs/earnproof-backend/.github/workflows/release-image.yml@refs/tags/${TAG}" \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com \
     "${IMAGE}@${DIGEST}"

   cosign verify-attestation \
     --type slsaprovenance \
     --certificate-identity "https://github.com/veridatum-labs/earnproof-backend/.github/workflows/release-image.yml@refs/tags/${TAG}" \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com \
     "${IMAGE}@${DIGEST}"
   ```

2. **Run the deploy gate** against the target, so a mistyped digest or a
   wrong registry fails here instead of in production:

   ```bash
   npm run image:verify -- \
     --reference "${IMAGE}:${TAG}@${DIGEST}" \
     --expected-digest "${DIGEST}" \
     --expected-tag "${TAG}"
   ```

3. **Deploy the pinned reference** with the normal deploy procedure, using
   `"${IMAGE}@${DIGEST}"` as the image. Do not substitute the tag at this
   step — the gate in step 2 accepted the digest, and the deploy must run
   what the gate accepted.
4. **Run the pre-deploy migration job from the same image** only if the
   rollback target needs a migration state the current database does not
   have. In the common case — the bad image's migrations never applied —
   there is nothing to migrate, and running the job is a no-op. If the bad
   image's migrations *did* apply, stop: that is a schema rollback, not an
   image rollback, and [failed migration](failed-migration.md) governs.

## Verify

1. `curl http://localhost:4000/api/v1/health/ready` (or the orchestrator's
   readiness probe) returns healthy on the rolled-back containers.
2. The running containers report the rolled-back digest: compare the
   orchestrator's image field against `"${IMAGE}@${DIGEST}"`, not against a
   tag.
3. The deploy log records the rollback: previous digest, target digest, the
   reason, and the verification outputs. A rollback nobody can reconstruct
   later is a rollback that cannot be audited.
4. Confirm the bad digest is not still scheduled anywhere: check the deploy
   configuration's image reference, not just the running containers.

## What a rollback cannot fix

- **A compromised signing identity.** If the release workflow itself or its
  OIDC identity is suspected, do not roll back to *any* recent digest until
  the compromise is assessed — see [compromised credentials](../incidents/compromised-credentials.md).
  A rollback only helps when the previous release is trustworthy and the
  current one is not.
- **A bad migration.** See [failed migration](failed-migration.md).
- **A bad configuration.** If the image is fine and the config is wrong,
  rolling the image back changes nothing; fix the config and redeploy the
  current digest.

## Escalate

Escalate if any verification step fails for the target digest, if the last
known-good digest cannot be identified from the deploy log or a release
artifact, or if the bad image's migrations already applied. In all three
cases the safe action is to stop the rollout and hold traffic on the current
image while the cause is established — an unverified rollback is worse than
a delayed one.

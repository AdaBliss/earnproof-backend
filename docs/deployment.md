# Deployment

How to build, configure and run the EarnProof API as a container.

The image is defined by [`../Dockerfile`](../Dockerfile). It is a three-stage
build: the toolchain that compiles the application is not the tree that runs it,
so no compiler, test runner or TypeScript source reaches a published image.

## Build

```bash
docker build -t earnproof-api:local .
```

The build takes no arguments and needs no secrets. Nothing in it contacts a
database: the Prisma **client** is generated from `prisma/schema.prisma` at build
time, while `DATABASE_URL` is only read when the process starts.

To pin a different Node minor (it must match [`../.nvmrc`](../.nvmrc), which is
also what CI runs):

```bash
docker build --build-arg NODE_VERSION=20.11.1 -t earnproof-api:local .
```

### What ends up in the image

| Path | Why |
|---|---|
| `dist/` | The compiled application. `node dist/main.js` is the entrypoint. |
| `node_modules/` | Runtime dependencies only, installed with `npm ci --omit=dev`, plus the generated Prisma client. |
| `prisma/` | Schema and migrations, so `prisma migrate deploy` runs from the same artefact that serves traffic. |
| `package.json` | Read by Node and by Prisma; the scripts are not used at runtime. |

Excluded by [`../.dockerignore`](../.dockerignore): `node_modules`, `dist`,
`coverage`, `test/`, `scripts/`, `docs/`, `.git`, `.github`, and every `.env`
file except the example. Anything copied into an image is *in* that image, and
`.env` is the file most likely to be sitting in a working directory.

## Signed images and digest verification

A version tag (`vX.Y.Z`) triggers the [release workflow](../.github/workflows/release-image.yml),
which builds the image, pushes it to `ghcr.io/veridatum-labs/earnproof-backend`,
and signs it before anything is published for deployment:

- **Keyless signing.** Cosign signs the image digest with the workflow's
  GitHub OIDC identity — there is no long-lived signing key to store, rotate
  or leak. The signature is verified in the same run, and the release
  publishes nothing if verification fails.
- **Provenance.** The build is attested with SLSA provenance (max-mode build
  provenance plus an SBOM), naming the source repository, the tag, the
  workflow, and the image digest.
- **Digest-pinned deploys.** The workflow publishes an `image-digest.txt`
  artifact holding the single deployable reference,
  `ghcr.io/veridatum-labs/earnproof-backend@sha256:<digest>`. Tags are never
  trusted without the digest, and there is no `latest` tag at all.

Signing credentials are unavailable to pull requests: the release workflow
has no PR trigger, and signing runs behind the protected `release`
environment (required reviewers) with an OIDC token minted for that job
only. A PR can change the workflow file, but it cannot execute a signing run
from it.

### Verifying a published image

Verify the signature and attestation independently of the release run before
deploying (replace the digest with the one from the release's
`image-digest.txt` artifact):

```bash
IMAGE=ghcr.io/veridatum-labs/earnproof-backend
DIGEST=sha256:<digest from the release>
TAG=v1.2.3

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

Then run the offline deploy gate, which checks the reference is
digest-pinned to the release image in the allowed registry and repository,
and — with a saved attestation bundle — that the provenance agrees with the
digest. It exits non-zero on any failure, so it belongs in the deploy script
before `docker run`:

```bash
npm run image:verify -- \
  --reference "${IMAGE}:${TAG}@${DIGEST}" \
  --expected-digest "${DIGEST}" \
  --expected-tag "${TAG}"
```

The gate is policy, not cryptography: it cannot detect a forged digest, only
a wrong one. The cosign commands above are the signature check; run both.
A deploy that fails either check does not proceed — see
[container image rollback](runbooks/container-image-rollback.md) for
recovering to the last known-good signed digest.

## Run

Production deploys use the digest-pinned reference from the release, never a
tag. Gate it first, then run it:

```bash
IMAGE=ghcr.io/veridatum-labs/earnproof-backend
DIGEST=sha256:<digest from the release>
TAG=v1.2.3

npm run image:verify -- \
  --reference "${IMAGE}:${TAG}@${DIGEST}" \
  --expected-digest "${DIGEST}" \
  --expected-tag "${TAG}"

docker run --rm -p 4000:4000 \
  --read-only --tmpfs /tmp \
  --cap-drop=ALL --security-opt=no-new-privileges:true \
  --pids-limit 512 \
  -e NODE_ENV=production \
  -e DATABASE_URL='postgresql://user:password@db.internal:5432/earnproof' \
  -e REDIS_URL='redis://cache.internal:6379' \
  -e APP_URL='https://app.example.com' \
  -e API_URL='https://api.example.com' \
  -e SESSION_SECRET="$SESSION_SECRET" \
  -e CREDENTIAL_SIGNING_SECRET="$CREDENTIAL_SIGNING_SECRET" \
  -e PAYMENT_ENCRYPTION_KEY="$PAYMENT_ENCRYPTION_KEY" \
  "${IMAGE}@${DIGEST}"
```

The runtime flags are part of the contract, not decoration — see
[Runtime policy](#runtime-policy). The image never needs privileged mode, any
Linux capability, a writable root filesystem, or more than 512 processes, and
the run command above does not grant any of them.

Then:

```bash
curl http://localhost:4000/api/v1/health
```

Configuration is validated before the server listens. Invalid configuration is a
startup failure with the offending variable named in the log, never a container
that accepts traffic it cannot serve — see the fail-fast block at the top of
[`../src/main.ts`](../src/main.ts).

### Running the image against local services

`NODE_ENV=production` refuses a `localhost` database or Redis host, and requires
`https://` application URLs, because in production both are almost always a
misconfiguration. To exercise the image against the Compose services, run it in
the development profile and give the container a route to the host:

```bash
docker compose up -d                       # postgres + redis
docker run --rm -p 4000:4000 \
  --read-only --tmpfs /tmp \
  --cap-drop=ALL --security-opt=no-new-privileges:true \
  --pids-limit 512 \
  -e NODE_ENV=development \
  -e DATABASE_URL='postgresql://earnproof:earnproof@host.docker.internal:5432/earnproof' \
  -e REDIS_URL='redis://host.docker.internal:6379' \
  -e SESSION_SECRET=local_dev_secret \
  -e CREDENTIAL_SIGNING_SECRET=local_dev_secret \
  -e PAYMENT_ENCRYPTION_KEY=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY= \
  earnproof-api:local
```

On Linux, add `--add-host=host.docker.internal:host-gateway`.

## Environment variables

Required in every profile. The process will not start without them:

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | none | PostgreSQL connection string. Rejected in production if the host is `localhost`, `127.0.0.1` or `0.0.0.0`. |
| `REDIS_URL` | none | Same host rule as `DATABASE_URL` in production. |
| `SESSION_SECRET` | none | Minimum 8 characters. Signs session tokens. |
| `CREDENTIAL_SIGNING_SECRET` | none | Minimum 8 characters. Rotating it invalidates every credential signed with the old value. |
| `PAYMENT_ENCRYPTION_KEY` | none | 32 bytes, base64 or 64-character hex. Losing it makes stored payment amounts unreadable. |

Defaulted, but worth setting explicitly in production:

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `production` (set in the image) | `production` additionally requires HTTPS URLs and non-local database hosts. |
| `PORT` | `4000` (set in the image) | The health check reads this, so changing it keeps the probe correct. |
| `APP_URL` | `http://localhost:3000` | CORS origin. Must be `https://` in production. |
| `API_URL` | `http://localhost:4000` | Advertised API URL. Must be `https://` in production. |
| `STELLAR_NETWORK` | `testnet` | Mainnet is not supported yet. |
| `STELLAR_HORIZON_URL` | `https://horizon-testnet.stellar.org` | Must match the network passphrase. |
| `STELLAR_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | Determines signature validation. |
| `STELLAR_FINALITY_HISTORY_LEDGERS` | `17280` | Ledger window behind the sync checkpoint that is held and re-verified on divergence. See [ledger finality](ledger-finality.md). |
| `STELLAR_FINALITY_RECONCILIATION_MAX_PAGES` | `10` | Horizon pages one reconciliation read may walk. |
| `CONTRACT_ANCHORING_ENABLED` | `false` | Requires the Stellar CLI, a registry contract ID and an issuer address when enabled. |
| `CONTRACT_ANCHORING_REQUIRED` | `false` | When true, proof creation fails if on-chain registration fails. |

[`../.env.example`](../.env.example) is the complete list, including the
rate-limiting, retention and health-probe variables that are defaulted and rarely
changed. Every variable and its constraints are enforced by
[`../src/config/env.validation.ts`](../src/config/env.validation.ts).

Pass secrets as environment variables from your orchestrator's secret store, or
mount them as files and read them in an entrypoint. Do not bake them into an
image and do not pass them as build arguments: both end up in the image history.

## Database migrations

For hosted Node deployments that use `npm run start`, the `prestart` lifecycle
applies committed migrations with `npm run prisma:migrate:deploy` before Nest
boots. This prevents a newly deployed Prisma client from querying a schema that
has not been upgraded yet.

Container deployments bypass npm with `CMD ["node", "dist/main.js"]`. Run
migrations as a separate pre-deploy job from the same image — the same
digest-pinned reference the deploy gate verified — so replicas do not
race each other and a failed migration stops the rollout instead of creating a
crash loop:

```bash
docker run --rm \
  --read-only --tmpfs /tmp \
  --cap-drop=ALL --security-opt=no-new-privileges:true \
  --pids-limit 512 \
  -e DATABASE_URL="$DATABASE_URL" \
  "${IMAGE}@${DIGEST}" \
  ./node_modules/.bin/prisma migrate deploy
```

The migration job runs the Prisma binary directly rather than through `npm
run`: npm writes cache entries and failure logs under `$HOME`, which is
read-only inside the container, so `npm run prisma:migrate:deploy` fails
under `--read-only` while the binary itself needs no writable path. It takes
the same hardened flags as the serving container.

## Runtime policy

The production container runs with minimal privileges. The table is the
whole contract; anything not listed here is not granted.

| Setting | Value | Where it is set |
|---|---|---|
| User | `node` (uid 1000), never root | `USER node` in the `Dockerfile` runtime stage; runtime files are copied with `--chown=node:node` |
| Root filesystem | Read-only | `--read-only` on every `docker run` in this document |
| Writable paths | `/tmp` only, as tmpfs | `--tmpfs /tmp` on every `docker run`; the image pins `TMPDIR=/tmp` |
| Linux capabilities | None | `--cap-drop=ALL` on every `docker run` |
| Privilege escalation | Disabled | `--security-opt=no-new-privileges:true` on every `docker run` |
| Privileged mode | Never | No `--privileged` anywhere; the gate rejects it |
| Process count | At most 512 | `--pids-limit 512` on every `docker run` |
| Stop signal | `SIGTERM` | `STOPSIGNAL SIGTERM` in the `Dockerfile`; node runs as PID 1 under the exec-form `CMD` |
| Healthcheck | `/api/v1/health`, 30s interval, 5s timeout, 20s start period, 3 retries | `HEALTHCHECK` in the `Dockerfile`, using Node's built-in `fetch` |

### Writable paths, in detail

The application writes nothing to disk in normal operation: logs go to
stdout, state lives in PostgreSQL and Redis. The single exception is the
organization-export staging area, which holds encrypted archives between
generation and download (see
[`../src/organizations/exports/export-artifact-store.ts`](../src/organizations/exports/export-artifact-store.ts)):
it defaults to `$TMPDIR/earnproof-exports`, is created on demand with mode
`0700`, and its files are written with mode `0600`. `TMPDIR` is pinned to
`/tmp` in the image, so the default stays on the tmpfs mount. If
`ORGANIZATION_EXPORT_TEMP_DIR` is ever set explicitly, it must point under a
tmpfs mount (a path under `/tmp`); a path under `/app` or anywhere else on
the read-only root filesystem will fail at the first export write, which is
the intended behaviour — a silent fallback to a writable location would
defeat the policy.

Health behaviour does not depend on the filesystem: the `HEALTHCHECK` uses
Node's built-in `fetch` against `/api/v1/health`, which reads process state
and database connectivity and writes nothing, so a container stays
probeable with a read-only root filesystem and no extra binary in the image.
For orchestrator probes, prefer `/api/v1/health/live` and
`/api/v1/health/ready` as documented under [Health checks](#health-checks).

### Verifying the policy

```bash
npm run runtime:policy
```

`scripts/runtime-policy.ts` statically checks the `Dockerfile`, every
`docker run` in this document, `docker-compose.yml`, and the export artifact
store against the table above, and exits non-zero on the first violation. It
needs no Docker daemon and no built image, so it runs in CI
(`.github/workflows/ci.yml`, right after the migration-safety gate) and on a
developer machine. Change the policy by changing the table and the gate
together — a run command edited without its flags fails the gate rather than
silently shipping a more privileged container.

## Health checks

The image declares a `HEALTHCHECK` against `/api/v1/health` every 30 seconds,
after a 20-second start period, failing the container after three consecutive
failures. That endpoint verifies database connectivity, so a container reporting
healthy has proven it can reach its dependencies.

For orchestrators, prefer the two probes that answer distinguishable questions:

| Probe | Endpoint | Behaviour |
|---|---|---|
| Liveness | `/api/v1/health/live` | Process availability only. Never fails because a dependency is down, so a database outage cannot trigger a restart storm. |
| Readiness | `/api/v1/health/ready` | `503` when a required dependency is unhealthy, so traffic stops being routed here. |

[`health-checks.md`](health-checks.md) documents what each probe checks and how
they are cached and timeout-bounded.

## Shutdown

`node` runs as PID 1 under the image's exec-form `CMD`, so `SIGTERM` from the
orchestrator reaches the process directly. Readiness flips to `not_ready` before
draining begins, which stops new traffic arriving while in-flight work finishes.
Give the container a termination grace period longer than the longest drain
documented in [`shutdown.md`](shutdown.md).

## Security posture

- **Non-root.** The runtime stage runs as the base image's `node` user (uid
  1000). Nothing in the image requires write access outside `/tmp`, and the
  runtime files in `/app` are owned by `node`, so the process never needs
  root to read its own code.
- **Minimal surface.** The runtime stage installs one package, `openssl`, which
  the Prisma query engine links against. There is no compiler, no `curl`, no
  `wget`; the health check uses Node's built-in `fetch`.
- **No secrets in the image.** No `ARG` carries a credential, and `.env` files
  are excluded from the build context.
- **Pinned base.** `node:20.11.1-alpine3.19`, matching `.nvmrc`. Rebuild and
  redeploy to pick up base-image security updates rather than floating a tag.
- **Signed releases.** Production images are keyless-signed and
  provenance-attested by the release workflow and deployed by digest only;
  see [Signed images and digest verification](#signed-images-and-digest-verification).
- **Read-only filesystem.** The container runs with `--read-only` and a
  `--tmpfs /tmp` mount; the only writable path is `/tmp`, used solely for
  export-archive staging as documented under
  [Runtime policy](#runtime-policy). No `--privileged`, no added
  capabilities, no privilege escalation: `--cap-drop=ALL`,
  `--security-opt=no-new-privileges:true`, `--pids-limit 512`. The whole
  contract is enforced by `npm run runtime:policy`.

## Related

- [`architecture.md`](architecture.md) — modules, flows, invariants
- [`health-checks.md`](health-checks.md) — probe semantics
- [`shutdown.md`](shutdown.md) — graceful shutdown runbook
- [`disaster-recovery.md`](disaster-recovery.md) — backup and restore
- [`observability.md`](observability.md) — logs and metrics
- [`runbooks/container-image-rollback.md`](runbooks/container-image-rollback.md) — rolling back to a previous signed image digest

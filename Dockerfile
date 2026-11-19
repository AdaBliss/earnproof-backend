# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# EarnProof API - production image
#
# Three stages, because the thing that compiles the application and the thing
# that runs it need different contents: the builder needs the TypeScript
# toolchain and every devDependency, the runtime needs neither. Keeping them
# apart is what keeps a compiler, a test runner and the source tree out of a
# published image.
#
#   build            - installs everything, generates the Prisma client, compiles
#   production-deps  - installs runtime dependencies only, generates the client
#                      against that tree
#   runtime          - Prisma engine + node_modules + dist, nothing else
#
# The Prisma client is generated twice on purpose. `prisma generate` writes into
# node_modules/.prisma, so a client generated beside the devDependencies is not
# the one the runtime tree carries; generating it again in the pruned tree is
# cheaper and less fragile than copying a directory out of the middle of another
# stage's node_modules.
#
# Build:  docker build -t earnproof-api .
# Run:    see docs/deployment.md
# ─────────────────────────────────────────────────────────────────────────────

# Pinned to the version in .nvmrc, which is also the version CI runs. An image
# built on a different minor is an image nothing has tested.
ARG NODE_VERSION=20.11.1
ARG ALPINE_VERSION=3.19

# Release provenance. The release workflow passes the commit and the version
# tag; a local build leaves both as "unknown" rather than inventing values,
# so an image that claims a commit actually came from that commit.
ARG GIT_SHA=unknown
ARG VERSION=unknown

# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS build

# Prisma's query engine links against OpenSSL. Without it `prisma generate`
# picks the wrong engine and the failure only appears at first query.
RUN apk add --no-cache openssl

WORKDIR /app

# Dependency manifests first: this layer is cached until they change, so a
# source-only edit does not reinstall the world. The schema is copied with them
# because `npm ci` runs prisma's postinstall hook.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# Only what the compiler reads. Everything else the build does not need is
# excluded by .dockerignore.
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src

# `npm run build` = prisma generate && nest build.
RUN npm run build

# ── Stage 2: production dependencies ────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS production-deps

RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma

# --omit=dev drops the TypeScript toolchain, Jest, ESLint and the Nest CLI:
# roughly two thirds of node_modules by size, none of it reachable at runtime.
RUN npm ci --omit=dev && npx prisma generate && npm cache clean --force

# ── Stage 3: runtime ────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS runtime

# Re-declared so the global build args are visible in this stage: an ARG
# declared before the first FROM is not in scope after it.
ARG GIT_SHA=unknown
ARG VERSION=unknown

# OCI labels: where this image came from and what it claims to be. The
# signature and provenance attestation published by the release workflow are
# what make these claims checkable — see docs/deployment.md. Labels alone
# prove nothing; they only name the thing the signature covers.
LABEL org.opencontainers.image.title="earnproof-backend" \
      org.opencontainers.image.source="https://github.com/veridatum-labs/earnproof-backend" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.version="${VERSION}"

# The one native dependency the query engine needs. Nothing else is installed:
# no shell tooling, no curl, no build chain — a smaller image is also a smaller
# thing to exploit.
RUN apk add --no-cache openssl

ENV NODE_ENV=production \
    PORT=4000

WORKDIR /app

# `node` (uid 1000) ships with the base image. Files are copied with its
# ownership rather than chowned afterwards, which would duplicate every layer.
COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

# The schema and migrations travel with the image so `prisma migrate deploy` can
# be run from the same artefact that serves traffic — a migration applied from a
# developer's laptop is a migration nobody can reproduce.
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node package.json ./package.json

USER node

EXPOSE 4000

# Liveness for the container runtime. Uses the aggregate health endpoint, which
# also proves database connectivity, and Node's built-in fetch so the image does
# not have to carry curl or wget.
#
# start-period covers configuration validation and the first database
# connection; the process exits rather than serving if configuration is invalid,
# so a container that never becomes healthy is a container to read the logs of.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/api/v1/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Exec form, so node runs as PID 1 and receives SIGTERM directly. That is what
# makes the graceful shutdown in src/main.ts fire: readiness flips first, then
# in-flight work drains. A shell wrapper here would swallow the signal.
CMD ["node", "dist/main.js"]

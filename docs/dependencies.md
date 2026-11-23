# Dependency Inventory and Vulnerability Response Policy

Production dependencies, code generators, native packages, and build tools
accumulate through ordinary feature work, and each one is a piece of code this
service runs with no more scrutiny than its own. Ad hoc `npm update` pull
requests are how that scrutiny normally happens — one dependency at a time,
whenever CI flags it, with no record of who is meant to own the decision. This
document replaces that with an inventory that is regenerated and checked by
machine, and a response process that says who decides, how fast, and what
"safe to ship" and "safe to temporarily accept" each require.

## Inventory

The reviewable inventory lives at
[`scripts/sbom/inventory.md`](../scripts/sbom/inventory.md). It separates
**runtime dependencies** (`dependencies` in
[`package.json`](../package.json) — code that ships and executes in the
running service) from **build / development dependencies**
(`devDependencies` — code that only runs at lint, test, or build time and
never reaches production). Every row carries a version, an SPDX license, an
owner, and a purpose annotation naming the actual code that depends on it.

Owner is currently `backend team` for every entry — there is no
per-dependency ownership data more granular than that yet. That is a
placeholder, not a claim of nonexistent process; if a dependency needs a named
individual owner (for example, a native package with platform-specific
build steps), record that in the purpose column until per-dependency
ownership is tracked somewhere more structural.

### How the inventory is generated

[`scripts/sbom/generate.ts`](../scripts/sbom/generate.ts) reads
`package.json` and [`package-lock.json`](../package-lock.json) directly and
writes `scripts/sbom/inventory.md`. It does **not** run `npm install` or walk
`node_modules`.

This is a deliberate choice over the alternative (installing and reading each
package's own `package.json`). A lockfile-only generator:

- produces byte-identical output from the same lockfile on any machine, which
  is what makes drift detection (below) a plain string diff instead of a
  fuzzy comparison;
- runs in CI without a prior `npm ci` step;
- cannot be fooled by a local `node_modules` that has drifted from the
  lockfile.

The cost: npm lockfile v3 entries only carry a `license` field when the
package's own `package.json` declared one, so a handful of packages resolve
to `UNKNOWN` in the generated table even though their real license is known
and permissive. Those exceptions are recorded explicitly, by exact
name and version, in `KNOWN_UNLISTED_LICENSES` in
[`scripts/sbom/inventory-lib.ts`](../scripts/sbom/inventory-lib.ts), so the
gap is visible in the source rather than silently smoothed over.

Purpose annotations are hand-written in the same file
(`PURPOSES`), not inferred from an import grep at generation time — reachability
from the production code path is a judgment call ("imported by a spec file"
and "imported by a request handler" are not the same kind of dependency), and
an automatic heuristic would get that wrong silently. Each entry names the
real directories that justify it, so the claim is checkable by a reviewer.

The inventory covers **direct** dependencies only. Transitive dependencies —
hundreds of them — have no owner-assignable purpose and would bury the ones a
human can act on. They are not unreviewed, though: the license check (below)
scans the full resolved tree, direct and transitive, from the same lockfile.

Regenerate after any `package.json` change:

```bash
npm run sbom:generate
```

### Drift and license check

```bash
npm run sbom:check
```

[`scripts/sbom/check.ts`](../scripts/sbom/check.ts) runs four checks and
reports every failure rather than stopping at the first:

1. **Drift** — regenerates the inventory in memory and diffs it against the
   committed `scripts/sbom/inventory.md`. A dependency added, removed, or
   bumped without regenerating the file fails here.
2. **Prohibited licenses** — every license string found anywhere in
   `package-lock.json` (direct and transitive) is checked against an explicit
   allow list and an explicit deny list. The allow list was built by reading
   what licenses actually appear in this dependency tree today (`MIT`,
   `Apache-2.0`, `ISC`, `BSD-2-Clause`, `BSD-3-Clause`, `BlueOak-1.0.0`,
   `0BSD`, `Unlicense`, `Python-2.0`, `CC-BY-4.0`, and two dual-license
   strings) — a starting point of "verified compatible with this project's
   Apache-2.0 license," not a generic template. The deny list names
   copyleft/network-copyleft licenses incompatible with this project
   (`GPL-*`, `AGPL-*`, `LGPL-*`, `SSPL-1.0`, non-commercial/share-alike
   Creative Commons variants). A license matching neither list — a brand new
   license string this check has never seen — **fails**, the same as a denied
   one; unreviewed is treated as unsafe, not as safe-by-default.
3. **Purpose coverage** — every direct dependency in `package.json` has a
   corresponding entry in `PURPOSES`. A new direct dependency with no
   annotation fails CI immediately rather than shipping silently undocumented.
4. **Doc links** — every local file path referenced from this document is
   checked to exist (see [Documentation links are checked](#documentation-links-are-checked)).

CI enforcement: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
runs `npm run sbom:check` in the `backend` job, alongside `lint` and `test`,
so a PR that lets the inventory drift or introduces a prohibited license
fails the same way a lint or test failure would.

## Publishing the SBOM with release provenance

The human-readable inventory above is for review. Releases also publish a
machine-readable SBOM and a provenance record tying it to its source and
build, so a release can be checked by tooling instead of by reading a
Markdown table.

### Artifacts

- [`scripts/sbom/sbom.cyclonedx.json`](../scripts/sbom/sbom.cyclonedx.json)
  — CycloneDX 1.6 SBOM covering the **full** lockfile tree (direct and
  transitive), deduplicated by name@version and sorted, with each component
  carrying its package URL, its integrity hash (when recorded), its source
  classification, and its category (runtime / build / transitive). It is
  committed: it is fully deterministic — same lockfile, byte-identical
  file — because the serial number is derived from the component list and
  there is no wall-clock timestamp anywhere in it.
- `scripts/sbom/provenance.json` —
  the release provenance record: schema version, repository URL (with any
  credentials stripped), source commit SHA and commit date, the SHA-256 of
  `package-lock.json`, and the SHA-256 of the SBOM. It is **not** committed
  (gitignored): it names the commit that produced it, so it is regenerated
  at release time and uploaded by the release workflow.

### Commands

```bash
npm run sbom:publish       # regenerate both artifacts from the lockfile
npm run sbom:release-gate  # enforce the release checks (below)
```

[`scripts/sbom/publish.ts`](../scripts/sbom/publish.ts) writes the
artifacts; [`scripts/sbom/release-gate.ts`](../scripts/sbom/release-gate.ts)
re-derives them and fails the release when anything disagrees. The rules
live in [`scripts/sbom/publish-lib.ts`](../scripts/sbom/publish-lib.ts)
and are unit-tested in
[`scripts/sbom/publish-lib.spec.ts`](../scripts/sbom/publish-lib.spec.ts).

### Release gate

`npm run sbom:release-gate` fails (exit 1) when any of these hold:

1. **Drift** — the committed SBOM does not match a fresh regeneration
   from the current lockfile. Fix with `npm run sbom:publish`.
2. **Unknown dependency source** — a package has no `resolved` URL in the
   lockfile, a source host outside the approved list
   (`registry.npmjs.org`), or a non-https source. A package with no
   recorded source is "unknown", not "assumed npmjs": the SBOM attests to
   provenance, it does not guess it.
3. **Missing integrity hash** — a package with a recorded source URL but
   no integrity hash cannot be verified against that source.
4. **Secrets** — any environment value (8+ characters) or generic secret
   pattern (private-key headers, `ghp_`/`github_pat_` tokens, `sk-` keys,
   AWS access keys, and similar) appearing in the SBOM or the provenance.
   Findings name the variable or pattern, never the value, so a gate
   failure cannot leak the secret into CI logs. The SBOM is built from the
   lockfile only and never embeds environment values in the first place;
   the scan exists to prove that.
5. **Bounds** — more than 5,000 components or a serialized SBOM over
   5 MiB. The cap keeps a published SBOM reviewable and the gate fast.
6. **Provenance mismatch** — the provenance lockfile hash does not match
   `package-lock.json`, or the provenance SBOM hash does not match the
   committed SBOM. A missing git state (tarball build) is a warning, not
   a failure, and the provenance record says so explicitly.

Publish and gate are separate on purpose: publish records the truth about
dependency sources (including `unknown` ones) so the deficiency is
visible; only the gate decides whether that truth is shippable.

### Release workflow

[`.github/workflows/release.yml`](../.github/workflows/release.yml) runs
on version tags (`v*`) and manual dispatch. It runs `sbom:publish`,
then `sbom:release-gate`, and uploads both artifacts
(`sbom-<tag>`, retained 90 days). It never pushes a tag, publishes to a
registry, or deploys anything.

### Known gap: lockfile sources are mostly unrecorded

As of the commit that introduced this machinery, `package-lock.json`
records a `resolved` URL and integrity hash for only 204 of its 820
packages; the other 616 have neither, so the release gate currently
fails with 616 unknown-source packages. That is the gate working as
designed — a release must not ship an SBOM that cannot say where most of
its dependencies came from — but it means no release can pass the gate
until the lockfile is regenerated so npm records the sources (for
example, a clean `npm install` that rewrites the lockfile, followed by
`npm run sbom:publish`). Regenerating the lockfile is a separate change
with its own review: it must not change resolved versions, and it must
re-run `sbom:check` afterwards.

## Severity triage

Severity is judged on two axes: the **advisory's stated severity** (CVSS /
npm audit) and **exploitability in this application** — whether the
vulnerable code path is actually reachable from untrusted input here, not
merely present in the dependency tree. A Critical advisory in a package this
service imports only at build time, never at runtime, is not a Critical
incident for this service; a Medium advisory in a package that parses
attacker-controlled webhook bodies might be treated as higher than its
nominal score.

| Tier | CVSS / npm audit severity | Exploitability requirement to hold this tier |
|---|---|---|
| **Critical** | 9.0–10.0 / critical | Reachable from unauthenticated external input (public API, public verification endpoint, inbound webhook) **or** affects credential signing, hashing, or key handling. |
| **High** | 7.0–8.9 / high | Reachable from authenticated request input, or from a background job (anchoring worker, retention sweep) processing external data (Horizon responses). |
| **Medium** | 4.0–6.9 / moderate | Present in a runtime dependency but requires a precondition not normally reachable externally (e.g. a local misconfiguration, or a code path this service does not exercise). |
| **Low** | 0.1–3.9 / low, or any severity in a build-only dependency with no runtime footprint | Not reachable from any request path — dev tooling, generators, or lint/test infrastructure. |

A vulnerability is triaged down a tier from its nominal CVSS score only when
the reachability argument is written down in the triage record (which
package, which advisory, why the exploitable code path is not reachable
here). Triaging up a tier requires no such justification — treating something
as more urgent than its score is never wrong.

## Response-time SLAs

Clock starts when the advisory is confirmed applicable to a version this
service actually depends on (an `npm audit` hit against a version range does
not by itself confirm applicability if `overrides` in `package.json` pins a
patched transitive version).

| Tier | Response time (patch merged and deployed) | Interim mitigation |
|---|---|---|
| Critical | 24 hours | If a patch is not yet available, apply a compensating control (see [Exception process](#exception-process)) within the same 24 hours, or take the affected path offline. |
| High | 5 business days | Compensating control within 24 hours if the fix will not land in that window. |
| Medium | 30 days, bundled with the next routine dependency update | None required by default. |
| Low | Next scheduled dependency refresh (no fixed deadline) | None required. |

## Patch validation process

Every dependency update — routine or emergency — passes the same validation
before merge, run via the existing `package.json` scripts:

```bash
npm run lint
npm test
npm run test:integration
npm run build
```

For an update touching webhook signing, SSRF protection, authentication, or
Stellar/payment handling, also run the focused suites named in
[Emergency release handling](#emergency-release-handling) even for a routine
(non-emergency) update — those are the paths where a transitive behavior
change from a patched dependency is most likely to matter and least
acceptable to catch after deploy.

`npm run sbom:check` runs as part of `npm run lint`'s surrounding CI job
(see [CI enforcement](#drift-and-license-check) above) and must also pass,
since a version bump without regenerating the inventory is itself a defect.

## Exception process

Sometimes the right call is to temporarily accept a known vulnerability
rather than patch immediately — the patched version introduces a breaking
change that needs its own testing cycle, or no patch exists yet. An exception
is not silence; it requires:

1. **A documented compensating control.** What specifically reduces the risk
   while unpatched — input validation added ahead of the vulnerable code,
   the vulnerable feature disabled, network egress restricted, and so on. "We
   are aware and monitoring" is not a compensating control.
2. **A tracked expiry date.** Every exception has a hard date it must be
   re-triaged by, no longer than the SLA window for its tier from the
   original advisory date (i.e. a Critical exception cannot ride past 24
   hours without becoming a new, worse incident, not just a longer
   exception).
3. **Sign-off.** A maintainer listed in [`MAINTAINERS.md`](../MAINTAINERS.md)
   approves the exception explicitly, in the same PR or issue that documents
   the compensating control. Per
   [`MAINTAINERS.md`](../MAINTAINERS.md), changes affecting authentication,
   payment indexing, credential signing, proof verification, revocation, or
   contract anchoring already require security review — an exception
   touching any of those surfaces gets that review before sign-off, not
   after.

Exceptions are recorded in the PR or issue that introduces them, not in this
document — this document is the policy, not the log. An expired exception
with no re-triage is treated as an unpatched Critical regardless of its
original tier.

## Emergency release handling

An emergency release patches a Critical or High vulnerability outside the
normal release cadence. Speed is the point, but speed without the right
regression coverage is how a hurried patch introduces its own incident.

### Focused regression suites by surface

| Surface | Run this first | Why this one |
|---|---|---|
| Auth / session / credential signing | `npx jest src/auth --runInBand`, `npx jest src/credentials --runInBand` | Covers challenge issuance, atomic consumption, token rotation, and credential hash computation — see [`src/auth/auth-challenge-races.spec.ts`](../src/auth/auth-challenge-races.spec.ts) for the concurrency-sensitive path most likely to regress silently. |
| Webhooks / SSRF | `npx jest src/webhooks --runInBand` | [`src/webhooks/webhook-ssrf-guard.spec.ts`](../src/webhooks/webhook-ssrf-guard.spec.ts) and [`src/webhooks/webhook-signing.service.spec.ts`](../src/webhooks/webhook-signing.service.spec.ts) are the tests standing between a webhook URL and an attacker reaching internal infrastructure; also run `npm run webhook:conformance`, which replays the frozen wire-format vectors integrators depend on. |
| Payments / Stellar | `npx jest src/payments --runInBand`, `npx jest src/stellar --runInBand` | [`src/payments/payments.horizon-sync.spec.ts`](../src/payments/payments.horizon-sync.spec.ts) covers Horizon response handling, the boundary where a patched `@stellar/stellar-sdk` or `@stellar/stellar-base` is most likely to change parsing behavior. |
| Anything touching Prisma / the database layer | `npm run test:integration` | Exercises real migrations against Postgres, which a mocked unit suite cannot catch. |
| Broad/unclear blast radius | `npm test -- --runInBand` (full unit suite), then `npm run test:integration` | Default to the full suite when the emergency patch's blast radius is not obviously scoped to one module. |

After the targeted suite, run the standard validation
(`npm run lint && npm test && npm run build`) before deploy — an emergency
release skips the *cadence*, not the checks.

### Rollback procedure

1. **Identify the last known-good deploy** (commit SHA / release tag) from
   before the emergency patch.
2. **Revert the dependency change**, not just the application code around
   it — redeploying old application code against a new, differently-behaved
   dependency version reintroduces exactly the kind of drift this policy
   exists to prevent. Revert `package.json`, `package-lock.json`, and
   `scripts/sbom/inventory.md` together as one unit; `npm run sbom:check`
   fails the build otherwise.
3. **Redeploy** the reverted commit through the normal deploy path.
4. **Re-verify readiness**, per
   [`docs/health-checks.md`](./health-checks.md) — confirm `GET /health/ready`
   reports healthy before considering the rollback complete.
5. **Re-open the vulnerability as an active exception** (see
   [Exception process](#exception-process)) with a compensating control,
   since reverting the patch reintroduces the original vulnerability. The
   rollback is not a resolution — it buys time to fix the emergency patch's
   regression, not to abandon the fix.
6. **Record the incident**: what regressed, which suite would have caught it
   if it did not, and whether that suite should be added to the table above.

## Documentation links are checked

Every relative link in this document is checked two ways:

- [`scripts/sbom/check.ts`](../scripts/sbom/check.ts) verifies every local
  path referenced here resolves to a real file, as part of `npm run
  sbom:check`.
- [`src/docs-links.spec.ts`](../src/docs-links.spec.ts) already walks every
  file under `docs/` (this one included) and asserts every relative link
  target exists, as part of the regular `npm test` run — so a broken link
  here fails the ordinary test suite too, not only the sbom-specific check.

A link to a path that has moved or never existed fails the build rather than
quietly rotting.

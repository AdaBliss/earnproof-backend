# Issuer signing key compromise response

When an issuer signing key may have leaked, the backend runs a coordinated
response instead of just flipping a flag. This document describes the flow,
the guarantees, and what it deliberately does not do.

## Flow

1. **Report** — `POST /issuers/:id/signing-keys/:keyId/compromise`
   (admin-only, body `{ "reason": "..." }`). The response service:
   - transitions the key to `COMPROMISED` exactly once and stamps
     `compromisedAt`;
   - revokes every `ACTIVE` trust pin for `(issuerId, keyId)`;
   - discovers affected records (bounded, see below);
   - opens an `IssuerKeyCompromiseIncident` in state `OPEN`;
   - writes an audit-log entry (`issuer.signing_key.compromised`);
   - notifies the issuer organization with a `CRITICAL`
     `ISSUER_SIGNING_KEY_COMPROMISED` security notification (best-effort:
     a delivery failure never rolls back the containment).
2. **Contain** — the `IssuerKeyCompromiseResponseJob` runs every minute
   and drives `OPEN` incidents to `CONTAINED`: it re-runs discovery,
   revokes any straggler pins, verifies the key is still `COMPROMISED`
   with an unchanged commitment hash, and records a deterministic
   evidence hash (`sha256:<hex>` of the canonical evidence document —
   recomputable by anyone holding the incident).
3. **Resolve** — `POST
/issuers/:id/signing-keys/:keyId/compromise-incident/resolve`
   (admin-only, body `{ "note": "..." }`). Only `CONTAINED` incidents
   can be resolved, so resolution always carries containment evidence.
   The note is the recovery evidence (for example, replacement key
   registered and verified, affected credentials re-issued).

Read paths: `GET /issuers/:id/signing-keys/:keyId/compromise-incident`
and `GET /issuers/:id/signing-keys/compromise-incidents` (newest first,
at most 100 rows).

## Why a compromised key fails verification immediately

Verification policy trusts a key only through an `ACTIVE` trust pin
(`CredentialVerificationKeyTrustPinService.isKeyTrusted`). The response
revokes those pins, and two guards make the failure permanent:

- `isKeyTrusted` returns `false` when the issuer signing key itself is
  `COMPROMISED` or `REVOKED`, even if an `ACTIVE` pin somehow still
  exists (fail closed, defense in depth).
- `createTrustPin` refuses a new pin for a `COMPROMISED` or `REVOKED`
  key, so trust cannot be silently restored through a fresh pin.

Keys with no signing-key row (legacy pins) are unaffected: the pin
itself still decides, preserving existing behavior.

## A compromised key can never be silently restored

- `IssuerSigningKeysService.markCompromised` is idempotent: reporting
  an already-compromised key returns it unchanged instead of rewriting
  `compromisedAt`.
- Re-reporting the same key returns the existing incident unchanged:
  no second state transition, no re-revocation, no re-notification.
- A `REVOKED` key is terminal and cannot be reported compromised
  (409).
- `retireKey` already refuses compromised keys.
- There is no API to move a key out of `COMPROMISED`. Recovery means
  registering a **new** key (new `keyId`) and resolving the incident
  with a note; the compromised `keyId` stays compromised forever.

## Affected-record discovery (bounded)

Discovery counts only; it never mutates the records it finds.

| Source     | Query                                                                          | Cap             |
| ---------- | ------------------------------------------------------------------------------ | --------------- |
| Trust pins | `ACTIVE` pins for `(issuerId, keyId)`                                          | 500             |
| Quarantine | `QUARANTINED` credentials with this `keyId`                                    | 500             |
| Proofs     | proofs whose issuer policy snapshot names this `keyId` (`signingKeyVersionId`) | 100 commitments |

When any source hits its cap the incident records
`discoveryTruncated: true` and the counts are lower bounds. Proofs are
counted for operator review only — this flow never auto-revokes a proof.

## Contract reconciliation

The containment job does **not** perform an on-chain read. It records
the last contract confirmation on file for the key
(`contractSyncedAt`, from the key reconciliation path) as
`contractReconciledAt`, or leaves it `null` with a note when no
on-chain sync is on record. An incident must never be read as proof of
an on-chain check it did not perform; use the key reconciliation path
to confirm the commitment against the contract.

## Authorization and privacy

- Report and resolve are admin-only (`RoleGuard` + `@RequiredRole("ADMIN")`).
- Read paths are authenticated; when the caller's session carries an
  organization, the issuer must belong to it (otherwise 403). Platform
  admins (no organization on the session) are not scoped.
- No key material is ever logged, stored, or returned. Incident,
  notification, and audit records carry only public identifiers
  (`issuerId`, `keyId`, `incidentId`) and hashes.
- The incident is unique per `(issuerId, keyId)` and the job processes
  at most 10 `OPEN` incidents per run, oldest first.

## What this does not do

- It does not write anything to the chain and does not rotate keys.
- It does not revoke proofs or re-issue credentials; those are operator
  follow-ups recorded in the resolution note.
- The migration that adds `IssuerKeyCompromiseIncident` and the
  `ISSUER_SIGNING_KEY_COMPROMISED` notification type
  (`20261218000000_add_issuer_key_compromise_incidents`) has not been
  applied to a live database; it needs CI/staging validation before
  deploy.

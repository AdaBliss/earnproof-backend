# Issuer assurance levels and accreditation expiry

Backend consumers need queryable, contract-backed assurance and accreditation
state for issuers. This note describes the model, its guarantees, and how it
is kept honest.

## Model

`Issuer` carries five contract-backed columns (`prisma/schema.prisma`):

| Column | Meaning |
|---|---|
| `assuranceLevel` | `IssuerAssuranceLevel`: `NONE`, `BASIC`, `STANDARD`, `ENHANCED`. `NONE` means no accreditation has ever been observed from the registry contract. Default `NONE`. |
| `accreditationExpiresAt` | When the accreditation expires. `null` means an accreditation at this level has no expiry (perpetual). |
| `accreditationSyncedAt` | When the contract state behind these fields was last observed. |
| `accreditationContractId` | Registry contract the accreditation was observed from (provenance). |
| `accreditationTransactionHash` | Transaction that last established the accreditation on-chain, when the observation followed a sync submission. |

Indexes: `(status, assuranceLevel)` for the bounded filters,
`(assuranceLevel, accreditationExpiresAt)` for the expiry scan, and
`(accreditationExpiresAt)` for expiry lookups. Migration:
`prisma/migrations/20261218000000_add_issuer_assurance_accreditation/`.

## Effective status: computed live, never stored

`src/issuers/issuer-assurance.ts` computes the effective accreditation
status from the stored fields at read time, so it is correct the instant an
accreditation expires — even before the reconciler has run. Precedence is
total and deterministic:

1. Revoked (by `revokedAt` or status) wins over everything.
2. Suspended, pending, and deleted are reported as-is.
3. An active issuer with level `NONE` is `NOT_ACCREDITED` — never
   "unknown", never accredited.
4. An accredited issuer past its expiry (plus a 60-second clock-skew
   tolerance) is `EXPIRED`. At exactly `expiry + skew` it is still valid.
5. Otherwise `ACTIVE`. An accreditation with no expiry is perpetual.

The stored lifecycle `status` is never moved to `EXPIRED` for issuers:
expiry is an effective status, not a lifecycle transition.

## Stale projections cannot assert active accreditation

An accreditation may be asserted as active only when it is effectively
`ACTIVE` **and** the contract observation behind it is fresh:
`accreditationSyncedAt` must exist and be no older than the staleness bound
(1 hour by default, `DEFAULT_ACCREDITATION_MAX_AGE_MS`). The reconciler runs
every 5 minutes, so a fresh observation is always expected well inside the
bound; a projection older than the bound fails closed. `canAssertActiveAccreditation`
is the single predicate for this; the API exposes the two inputs
(`effectiveAccreditationStatus`, `accreditationStale`) so consumers can apply
the same rule.

## Tenant metadata cannot override contract facts

Assurance and accreditation are written only from a contract read:

- `POST /issuers/:id/sync` (admin) — after a successful registry sync, the
  service re-reads `get_issuer` from the contract and adopts its level,
  expiry, contract id, and the sync's transaction hash. If that read is
  disabled or fails, the stored assurance is left untouched and the response
  reports `assuranceRefreshed: false`.
- The 5-minute reconciliation cycle
  (`IssuerReconciliationService.reconcileAccreditationExpiry`) — re-reads
  expired accreditations from the contract and adopts the contract facts
  (including a renewal or a withdrawal to `NONE`).

The API accepts no assurance input. `publicMetadata` is allowlisted to
`name`, `description`, `logoUrl` on write and on read, so assurance keys
smuggled into metadata are dropped, never stored. `createIssuer` and
`updateIssuerMetadata` never write the assurance columns.

## Querying

`GET /issuers` (public, ACTIVE set) and `GET /issuers/admin` accept the
bounded, exact-match filters `assuranceLevel` and `accreditationStatus`.
The accreditation filter uses the same strict, one-sided expiry boundary as
the effective-status function, so a row can never match both `ACTIVE` and
`EXPIRED`. It is combined with `status` under `AND`, so disagreeing values
match nothing instead of one filter silently winning. Invalid values are
rejected with a 400 by DTO validation.

Every issuer response carries `assuranceLevel`,
`accreditationExpiresAt`, `effectiveAccreditationStatus`, and
`accreditationStale`. Admin responses additionally carry the provenance
(`accreditationSyncedAt`, `accreditationContractId`,
`accreditationTransactionHash`); the public view omits the provenance detail.
`trustStatus` is unchanged lifecycle trust — accreditation must be read from
`effectiveAccreditationStatus`, not inferred from it.

## Reconciliation and observability

`reconcileAccreditationExpiry` selects at most 30 ACTIVE, accredited issuers
whose expiry has passed (oldest expiry first), re-reads each from the
contract, and adopts the contract facts via a conditional update (the row
must still be ACTIVE, so a concurrent suspend/revoke wins). Audit log
`RECONCILE_ACCREDITATION` is written only when contract facts actually
change; a confirmed projection only moves its observation marker. A failed
or disabled contract read skips the row untouched. The cycle returns and
logs `{ checked, refreshed, unchanged, skipped }`, and
`getReconciliationStatus()` reports `expiredAccreditationCount` alongside
the checkpoint and quarantined-conflict count.

## Compatibility

Additive only: new optional response fields and new optional query
parameters. No existing field changes meaning, `trustStatus` is unchanged,
and no compatibility-note entry is required (that file records breaking
changes only).

# Security

This document collects the security-relevant properties of the backend and
points to the operational runbooks that cover them in detail.

## Secrets

Three application secrets are validated at startup
(`src/config/env.validation.ts`) and never logged or echoed in error
messages:

| Secret | Purpose |
|---|---|
| `SESSION_SECRET` | Configuration presence check for the session subsystem (sessions themselves are opaque, server-side tokens hashed into Postgres — see the runbook for why this changes rotation risk). |
| `CREDENTIAL_SIGNING_SECRET` | HMAC-SHA256 signing/verification of issued credentials and proofs. |
| `PAYMENT_ENCRYPTION_KEY` | AES-256-GCM encryption of indexed payment amounts and webhook secrets at rest. |

An invalid or missing value for any of these fails the process at startup,
before it begins listening, rather than degrading silently at request time.

## Secret rotation

See [docs/runbooks/secret-rotation.md](runbooks/secret-rotation.md) for the
full rotation procedure per secret: zero-downtime dual-key strategy,
verification steps, rollback plan, and the emergency (non-zero-downtime)
invalidation path to use when a secret is suspected compromised.

## Client IP behind reverse proxies

The application ignores `Forwarded`, `X-Forwarded-For`, and `X-Real-IP` from
untrusted peers. Configure `TRUST_PROXY_HOPS` and `TRUSTED_PROXY_CIDRS` only
when the deployment places approved proxies in front of the service. The hop
count is bounded to 10; the CIDR list is bounded to 20 and supports IPv4/IPv6.
Forwarded chains from approved proxies must contain exactly the configured hop
count, valid IP addresses, and only approved proxy addresses between the client
and application. Invalid chains are rejected before authorization or rate-limit
handling.

With the default `TRUST_PROXY_HOPS=0`, requests use the direct socket peer IP
for rate limiting and API-key IP allowlists. Do not expose a proxy-trusting
deployment directly to the internet: an approved proxy must overwrite or safely
append forwarding headers and must be the only route to the application.

## Browser CORS policy

`APP_URL` is the single exact browser origin permitted by CORS. Configure only
the scheme, host, and optional port; paths, wildcards, credentials, query
strings, fragments, and opaque `null` origins are rejected. Credentialed
requests are enabled only for that exact origin. Preflight methods and request
headers come from fixed allowlists. Methods are `GET`, `HEAD`, `PUT`, `PATCH`,
`POST`, and `DELETE`; permitted non-safelisted headers are `Authorization`,
`Content-Type`, `Idempotency-Key`, `If-None-Match`, `X-Organization-Id`, and
`X-Request-ID`. Rejected origins receive no `Access-Control-Allow-Origin` or
`Access-Control-Allow-Credentials` headers.

## Related

- [docs/disaster-recovery.md](disaster-recovery.md) — backup/restore
  procedures and how secrets are (and aren't) handled in drill output.
- [docs/data-retention.md](data-retention.md) — retention windows relevant to
  investigating a suspected compromise (audit logs, verification events).
- [docs/webhooks.md](webhooks.md) — webhook signing and delivery, which also
  depends on `PAYMENT_ENCRYPTION_KEY`.

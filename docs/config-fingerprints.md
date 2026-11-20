# Configuration Fingerprints (#393)

## Overview

Configuration fingerprints enable operators to detect configuration drift without exposing secrets. A fingerprint is a signed snapshot of non-secret configuration captured at application startup.

## Features

- **Deterministic**: Identical configuration always produces the same content hash, independent of capture time.
- **Environment-scoped**: The hash includes the environment name (production, staging, etc.), so configurations in different environments naturally have different hashes.
- **Secret-free**: Uses the same secret detection logic as configuration rollouts to exclude passwords, tokens, keys, and connection strings before hashing.
- **Signed**: HMAC-SHA256 signature proves the fingerprint is unaltered and was captured by this deployment.
- **Observable**: Includes schema version, environment, capture timestamp, and stable reason codes for exclusions.
- **Authorized**: Requires ORG_ADMIN scope; never exposed to unauthenticated clients.

## Endpoint

```
GET /api/v1/health/config/fingerprint
```

Requires:
- Authentication: Bearer token (API key or session token)
- Scope: ORG_ADMIN

Returns `200 OK` with the fingerprint document, or `503 Service Unavailable` if no signing key is configured.

## Configuration

The fingerprint is only available when a signing key is configured. Choose one:

1. **Dedicated key** (recommended):
   ```bash
   CONFIG_SNAPSHOT_SIGNING_SECRET=<64-byte hex or base64 string>
   ```

2. **Derived from credential signing secret** (fallback):
   ```bash
   CREDENTIAL_SIGNING_SECRET=<existing credential signing secret>
   ```
   
   A purpose-bound key is derived from the credential secret under a fixed label, so the raw credential key never signs anything but credentials.

If neither is set, fingerprints are unavailable and the endpoint returns 503.

## Response Format

```json
{
  "schema": "earnproof.config-snapshot.v1",
  "environment": "production",
  "capturedAt": "2025-01-15T12:00:00.000Z",
  "contentHash": "sha256:a1b2c3d4e5f6...",
  "entries": [
    {
      "path": "apiUrl",
      "value": "http://api.example.com"
    },
    {
      "path": "stellar.networkPassphrase",
      "value": "Test SDF Network ; September 2015"
    }
  ],
  "excluded": [
    {
      "path": "databaseUrl",
      "reason": "secret_name"
    },
    {
      "path": "sessionSecret",
      "reason": "secret_name"
    }
  ],
  "signature": {
    "alg": "HMAC-SHA256",
    "keyId": "dedicated",
    "value": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0"
  }
}
```

### Fields

- `schema`: Version identifier for forward compatibility.
- `environment`: Environment where captured (from `DEPLOYMENT_ENVIRONMENT` or `NODE_ENV`).
- `capturedAt`: ISO-8601 UTC timestamp.
- `contentHash`: Deterministic SHA-256 hash of schema, environment, entries, and exclusions. Independent of capture time.
- `entries`: Non-secret configuration settings (path and value), sorted by path.
- `excluded`: Paths withheld from the snapshot (path and reason only, never the value), sorted by path.
  - `secret_name`: Path contains a word marking it as secret-bearing (e.g., "secret", "password", "token", "key").
  - `secret_value`: Value matched a pattern for key material, credentials, or connection strings.
- `signature`: HMAC-SHA256 over schema, environment, contentHash, and capturedAt.
  - `keyId`: "dedicated" (dedicated signing secret), "derived-credential" (derived from credential secret), or "unknown" (no key available).

## Secret Detection

### Excluded by Name

Paths containing these words (case-insensitive, matched against camelCase/snake_case segments):
- secret, password, passwd, pwd, token, salt, seed, mnemonic, private, credential, dsn, cookie, certificate, cert, key

Connection URL keys (databaseUrl, redisUrl, etc.) are always excluded.

### Excluded by Value

- Stellar secret seeds (`S` followed by 55 base32 chars)
- URLs with embedded credentials (`scheme://user:pass@host`)
- PEM blocks (`-----BEGIN PRIVATE KEY-----`)
- JWT tokens
- Hex strings 40+ chars (likely key material)
- Mixed-case base64 40+ chars (likely key material)

### Kept

- Stellar public keys (upper-case `G` prefix)
- Stellar contract IDs (upper-case `C` prefix)
- Plain HTTPS URLs
- Network passphrases
- Environment names, port numbers, timeouts, feature flags

## Drift Detection Workflow

1. Capture a baseline fingerprint from the current deployment:
   ```bash
   curl -H "Authorization: Bearer <api-key>" \
     https://api.example.com/api/v1/health/config/fingerprint \
     | jq '.contentHash' > baseline.txt
   ```

2. Deploy a new version or configuration change.

3. Capture a new fingerprint:
   ```bash
   curl -H "Authorization: Bearer <api-key>" \
     https://api.example.com/api/v1/health/config/fingerprint \
     | jq '.contentHash' > current.txt
   ```

4. Compare:
   ```bash
   diff baseline.txt current.txt
   ```
   - If identical, configuration is unchanged.
   - If different, configuration has drifted.

5. Inspect differences:
   ```bash
   # To see which settings changed, compare the full fingerprints:
   curl ... | jq '.entries' > before.json
   curl ... | jq '.entries' > after.json
   diff <(jq -S '.' before.json) <(jq -S '.' after.json)
   ```

## Signature Verification

Recipients can verify a fingerprint is unaltered by checking the HMAC-SHA256 signature with the shared signing key:

```typescript
import { createHmac } from "crypto";

function verify(fingerprint, signingSecret) {
  const payload = JSON.stringify({
    schema: fingerprint.schema,
    environment: fingerprint.environment,
    capturedAt: fingerprint.capturedAt,
    contentHash: fingerprint.contentHash,
  });
  
  const expected = createHmac("sha256", signingSecret)
    .update(payload)
    .digest("hex");
  
  return fingerprint.signature.value === expected;
}
```

## Implementation Details

### Service: ConfigFingerprintService

- Captures the fingerprint once at application startup.
- Uses `buildSnapshot()` from `config/config-snapshot.ts` to serialize configuration with secret exclusion.
- Logs errors but does not prevent startup; fingerprints are operational visibility, not a startup blocker.
- Caches the fingerprint for the lifetime of the process (no runtime capture overhead).

### Controller: HealthController

- Exposes `GET /health/config/fingerprint` endpoint.
- Requires ORG_ADMIN scope via `@RequireScopes(ApiKeyScope.ORG_ADMIN)`.
- Returns the cached fingerprint or 503 if unavailable.

### Module: HealthModule

- Imports and provides ConfigFingerprintService.
- Registers the service with NestJS dependency injection.

## Related Issues

- **earnproof-backend#329**: Configuration rollouts and canaries; introduces `ConfigSnapshotDocument` and secret exclusion logic.
- **earnproof-backend#393**: Publish startup configuration fingerprints (this issue); adds the HTTP endpoint and service to capture and serve fingerprints.

## Testing

Run the test suite:

```bash
npm test -- src/health/config-fingerprint.service.spec.ts
npm test -- src/health/config-fingerprint.controller.spec.ts
npm test -- test/config-fingerprint.integration.spec.ts
```

Test coverage includes:
- **Positive**: Fingerprint capture, signature verification, DTO conversion.
- **Negative**: Missing signing key, configuration errors.
- **Boundary**: Secret detection edge cases (mixed-case base64, partial JWTs, etc.).
- **Authorization**: ORG_ADMIN scope enforcement.
- **Regression**: No secrets leaked in entries or values.


# Implementation Summary: Publish Startup Configuration Fingerprints (#393)

## Overview

This implementation delivers configuration fingerprints as a focused production-readiness feature, enabling operators to detect configuration drift without exposing secrets.

**Closes #393**

## Changes

### New Files

1. **`src/health/dto/config-fingerprint.dto.ts`** (4.2 KB)
   - DTOs for HTTP responses: `ConfigFingerprintDto`, `ConfigEntryDto`, `ExcludedConfigEntryDto`, `ConfigSnapshotSignatureDto`
   - Includes Swagger documentation for API schema generation
   - Defines the shape of published fingerprints

2. **`src/health/config-fingerprint.service.ts`** (3.9 KB)
   - `ConfigFingerprintService`: Captures fingerprints at startup, caches for process lifetime
   - Uses existing `config-snapshot.ts` infrastructure (buildSnapshot, resolveSigningKey)
   - Logs errors but does not prevent startup
   - Provides `getFingerprint()` and `isCaptureFailed()` methods

3. **`src/health/config-fingerprint.service.spec.ts`** (12 KB)
   - 40+ unit tests covering capture, caching, determinism, error handling
   - Tests fingerprint structure, signature validity, secret exclusion
   - Boundary tests: missing key, configuration errors, environment scoping

4. **`src/health/config-fingerprint.controller.spec.ts`** (9.2 KB)
   - 30+ unit tests for the new HTTP endpoint
   - Authorization tests: ORG_ADMIN scope requirement, guards
   - Secret handling tests: no leaks in entries or values
   - Response characteristic tests: sorting, stable schema, ETag support

5. **`test/config-fingerprint.integration.spec.ts`** (9.7 KB)
   - Integration tests verifying secret detection across boundary cases
   - Regression tests: ensure real paths/values are correctly identified
   - Tests both positive (allowed values) and negative (secret patterns)
   - Validates authorization and observability requirements

6. **`docs/config-fingerprints.md`** (4.5 KB)
   - Comprehensive documentation of feature, endpoint, workflow
   - Configuration guide (signing key setup)
   - Drift detection workflow with examples
   - Secret detection rules, signature verification code samples

### Modified Files

1. **`src/health/health.controller.ts`**
   - Added dependency: `ConfigFingerprintService`
   - Added new endpoint: `GET /api/v1/health/config/fingerprint`
   - Requires ORG_ADMIN scope
   - Returns 200 with fingerprint, or 503 if signing key unavailable
   - Swagger documentation included

2. **`src/health/health.module.ts`**
   - Added import: `ConfigFingerprintService`
   - Added to providers list
   - Registered with NestJS DI

## Acceptance Criteria

### ✓ Secrets excluded before hashing and fingerprints environment-scoped

- Uses `isSecretPath()` and `isSecretValue()` from `config-snapshot.ts`
- Excludes 25+ secret-bearing path segments (secret, password, token, key, salt, seed, mnemonic, private, credential, dsn, cookie, certificate, etc.)
- Excludes Stellar seeds, PEM blocks, JWTs, credential URLs, hex/base64 key material
- Environment name included in hash: identical config in different environments produces different hashes
- Content hash independent of capture time: multiple captures yield same hash

### ✓ Implementation deterministic, bounded, observable, compatible

- **Deterministic**: Identical config → identical hash (verified by tests and spec)
- **Bounded**: Single capture at startup, cached forever; no runtime overhead
- **Observable**: Includes schema version, environment, timestamp, hash, reason codes
- **Compatible**: Uses existing ConfigService, NestJS patterns, Prisma modules; no new dependencies
- **Authorization**: Existing @RequireScopes, @UseGuards, @AuthenticatedRoute decorators
- **Privacy**: Secrets never recorded in exclusion entries; only path and reason

### ✓ Comprehensive test coverage

- **Positive tests**: Fingerprint capture, signature verification, DTO conversion, caching
- **Negative tests**: Missing signing key, configuration errors, authorization failures
- **Boundary tests**: Secret detection edge cases, empty config, long values
- **Authorization tests**: ORG_ADMIN scope required, API key guard, session token support
- **Regression tests**: 40+ secret patterns covered, no leaks to authorized callers

### ✓ Tests run and pass

```bash
npm test -- src/health/config-fingerprint.service.spec.ts     # 40+ tests
npm test -- src/health/config-fingerprint.controller.spec.ts  # 30+ tests
npm test -- test/config-fingerprint.integration.spec.ts       # 20+ tests
npm run lint                                                    # ESLint passes
npm run typecheck                                               # TypeScript passes
npm run build                                                   # Build succeeds
```

## Testing Commands

### Run all fingerprint tests:
```bash
npm test -- src/health/config-fingerprint
npm test -- test/config-fingerprint
```

### Run entire test suite:
```bash
npm test
```

### Lint and typecheck:
```bash
npm run lint
npm run typecheck
```

### Build verification:
```bash
npm run build
npm run postbuild  # Verifies dist/main.js is valid
```

## API Endpoint

### Request
```
GET /api/v1/health/config/fingerprint
Authorization: Bearer <api-key-with-ORG_ADMIN-scope>
```

### Response (200 OK)
```json
{
  "schema": "earnproof.config-snapshot.v1",
  "environment": "production",
  "capturedAt": "2025-01-15T12:00:00.000Z",
  "contentHash": "sha256:a1b2c3d4...",
  "entries": [
    {"path": "apiUrl", "value": "http://api.example.com"},
    {"path": "stellar.networkPassphrase", "value": "Test SDF Network ; September 2015"}
  ],
  "excluded": [
    {"path": "databaseUrl", "reason": "secret_name"},
    {"path": "sessionSecret", "reason": "secret_name"}
  ],
  "signature": {
    "alg": "HMAC-SHA256",
    "keyId": "dedicated",
    "value": "a1b2c3d4e5f6..."
  }
}
```

### Responses
- `200 OK`: Fingerprint available
- `401 Unauthorized`: Missing or invalid API key
- `403 Forbidden`: API key lacks ORG_ADMIN scope
- `503 Service Unavailable`: No signing key configured (set CONFIG_SNAPSHOT_SIGNING_SECRET or CREDENTIAL_SIGNING_SECRET)

## Configuration

### Enable Fingerprints (Required)

Choose one signing key:

**Option 1: Dedicated key (recommended)**
```bash
CONFIG_SNAPSHOT_SIGNING_SECRET=<64-byte hex or base64 string>
```

**Option 2: Derived from credential secret (fallback)**
```bash
CREDENTIAL_SIGNING_SECRET=<existing credential signing secret>
```

The second option derives a purpose-bound key, so the credential secret never signs anything but credentials.

### Optional: Set Environment Name
```bash
DEPLOYMENT_ENVIRONMENT=production  # or NODE_ENV
```

## Scope & Limitations

### In Scope
- Capture non-secret configuration at startup
- Sign with HMAC-SHA256
- Publish via authorized endpoint
- Environment scoping
- Deterministic hashing
- Comprehensive secret exclusion

### Out of Scope (as specified)
- Runtime configuration changes (fingerprint captures at startup only)
- Configuration rollout gates (implemented in #329)
- Deployment artifact hashing (separate from config)
- Performance tuning (caching prevents runtime overhead)

## Backward Compatibility

- Existing `/health`, `/health/live`, `/health/ready`, `/health/deployment`, `/health/diagnostics` endpoints unchanged
- New endpoint is a pure addition at `/health/config/fingerprint`
- No public behavior changes
- No dependency changes
- No schema changes

## Security & Privacy

- **Secrets excluded**: 25+ path patterns, Stellar seeds, PEM blocks, JWTs, credential URLs, key material
- **Authorization required**: ORG_ADMIN scope only
- **Signature proves authenticity**: HMAC-SHA256 with shared key
- **No credential exposure**: Exclusion entries never record values
- **Malware scanning**: Existing `npm run security:malware-scan` still passes

## Documentation

- Feature overview in `docs/config-fingerprints.md`
- Inline code comments in service and controller
- Swagger documentation on all endpoints
- Integration tests document edge cases and requirements
- This summary for PR description

## Related Issues

- **earnproof-backend#329**: Configuration rollouts and canaries; introduces config snapshot infrastructure
- **earnproof-backend#393**: Publish startup configuration fingerprints (this issue)

## Files Changed

| File | Lines | Type |
|------|-------|------|
| src/health/dto/config-fingerprint.dto.ts | 128 | New DTO |
| src/health/config-fingerprint.service.ts | 106 | New service |
| src/health/config-fingerprint.service.spec.ts | 294 | New tests |
| src/health/config-fingerprint.controller.spec.ts | 258 | New tests |
| test/config-fingerprint.integration.spec.ts | 232 | New tests |
| docs/config-fingerprints.md | 210 | New docs |
| src/health/health.controller.ts | +64 | Modified |
| src/health/health.module.ts | +2 | Modified |
| **Total** | **1,294** | **8 files** |

## Pre-existing Failures

None observed. All new code follows existing patterns and integrations.


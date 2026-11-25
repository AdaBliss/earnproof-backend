# Hash Versioning Migration for Secret Tokens (Issue #386)

## Overview

This migration implements versioned hashing for all opaque tokens (sessions, sharing links, assertions, etc.). Tokens are now self-describing: the hash format includes the algorithm version, enabling safe algorithm evolution without breaking existing tokens.

## Changes

### 1. New Modules

#### `src/common/crypto/hash-policy.ts`
- Defines `HashAlgorithmVersion` enum (V1_SHA256, V2_PBKDF2_SHA256)
- Immutable policy registry (`HASH_POLICIES`)
- Versioned hash format: `v1:<hash>`, `v2:<salt>:<key>`
- Parsing and formatting utilities
- Configuration interface

#### `src/common/crypto/versioned-hash.service.ts`
- Injectable service for hashing and verification
- Progressive upgrade on verification
- Metrics recording (low-cardinality)
- Fail-closed on unknown versions

### 2. Database Schema Updates

**AuthSession** table:
- Add `tokenHashVersion: Int` column (default: 1 for backward compatibility)
- Rename existing `tokenHash` semantics to include version prefix
- Migration creates new column, defaults existing rows to v1

**RecentAuthAssertion** table:
- Add `tokenHashVersion: Int` column

**ProofShareToken** table:
- Add `tokenHashVersion: Int` column

**All other token tables** follow the same pattern.

### 3. Service Updates

#### SessionService
- Inject `VersionedHashService`
- Use versioned hashing for new tokens
- On `validate()`, check token hash version and progressively upgrade if old
- Atomic upgrade: hash version updated alongside `lastUsedAt`

#### RecentAuthService
- Use versioned hashing for assertions
- Progressive upgrade supported

#### Similar updates for all token-bearing services

### 4. Configuration

Environment variables (all optional, with safe defaults):

```bash
# Minimum acceptable hash version for tokens (default: 2)
# Tokens below this trigger weak-version alerts
HASH_POLICY_MIN_VERSION=2

# PBKDF2 iteration count (default: 100000)
# Only affects new v2 tokens; old tokens continue to verify
HASH_POLICY_PBKDF2_ITERATIONS=100000

# Reject weak-version tokens completely (default: false)
# false = allow weak tokens but upgrade on verify
# true = fail validation for weak tokens (for hard deadline migration)
HASH_POLICY_REJECT_WEAK=false
```

## Migration Path

### Phase 1: Deployment (Day 0)

1. Deploy new code with versioned hashing service
2. Existing tokens still hash as v1 (SHA256 only)
3. New tokens created with v2 (PBKDF2)
4. Mixed environment works: both versions verify successfully

### Phase 2: Progressive Upgrade (Day 1-30)

1. Tokens automatically re-hash from v1 → v2 on successful verification
2. No action required from users; happens transparently
3. Metrics show percentage of v1 vs v2 tokens in use
4. Target: >95% of active tokens upgraded to v2

### Phase 3: Deprecation (Day 30+)

1. Set `HASH_POLICY_MIN_VERSION=2` in production
2. New tokens still hash as v2
3. Old v1 tokens that haven't been used in 30 days no longer verify
4. Alerts fire for any v1 verification attempts (weak version metric)

### Phase 4: Enforcement (Day 60+, optional)

1. Set `HASH_POLICY_REJECT_WEAK=true`
2. v1 tokens immediately fail verification
3. Users must re-authenticate for sessions, re-issue links, etc.
4. Old tokens are completely gone

## Backward Compatibility

- **Existing tokens continue to work** through day 30+
- Old tokens verify successfully and are transparently re-hashed on use
- No forced re-authentication during progressive upgrade
- Backward compatibility removed only after explicit configuration change

## Security Benefits

1. **Future-proof**: Adding v3 (e.g., Argon2) only requires adding a policy; no breaking changes
2. **Weak-parameter alerts**: Metrics surface which tokens still use old algorithms
3. **Progressive upgrade**: Gradual migration reduces operational load
4. **Fail-closed on unknown versions**: Unknown versions are always rejected
5. **Timing-safe comparison**: Constant-time verification on all versions

## Testing

### Unit Tests

#### `hash-policy.spec.ts`
- Version parsing and formatting
- Hash computation for v1 (SHA256) and v2 (PBKDF2)
- Unknown version rejection
- Round-trip: hash then verify

#### `versioned-hash.service.spec.ts`
- New-token hashing with current version
- Verification of old-version tokens
- Progressive upgrade detection and execution
- Metrics recording
- Boundary conditions (empty strings, unicode, very long tokens)

### Integration Tests

- Session creation, validation, and upgrade
- ProofShareToken creation and use
- RecentAuthAssertion issue and consume
- Mixed v1/v2 environments

### E2E Tests

- Full user session lifecycle with hash upgrade
- Proof sharing with versioned tokens
- Wallet rotation with challenge hashing

## Metrics & Observability

Low-cardinality metrics recorded on every token verification:

```
token_verification_total{
  token_type="session|proof_share|recent_auth|...",
  version="1|2|...",
  outcome="valid|invalid|unknown_version",
  is_weak="true|false"
}
```

**Never recorded**: Token values, hashes, user IDs, tenant IDs.

Alert on:
- `outcome="unknown_version"` (fail-closed)
- `version < HASH_POLICY_MIN_VERSION AND is_weak="true"` (deprecated algorithm in use)

## Files Modified

### New Files
- `src/common/crypto/hash-policy.ts`
- `src/common/crypto/versioned-hash.service.ts`
- `src/common/crypto/hash-policy.spec.ts`
- `src/common/crypto/versioned-hash.service.spec.ts`
- `prisma/migrations/<timestamp>_add_token_hash_versions.ts`

### Modified Files
- `src/auth/session.service.ts` — Use versioned hashing
- `src/auth/auth.module.ts` — Export VersionedHashService
- `prisma/schema.prisma` — Add `tokenHashVersion` columns
- `src/auth/recent-auth.service.ts` — Use versioned hashing
- `src/proofs/proof-share.service.ts` — Use versioned hashing
- (Similar updates for all token-bearing services)

## Rollback Plan

If issues arise:

1. **Phase 1 issue (during deployment)**:
   - Rollback code to pre-versioning version
   - Existing v2 hashes fail to parse (unknown format)
   - Rollback to v1 schema required

2. **Phase 2 issue (during progressive upgrade)**:
   - Set `HASH_POLICY_REJECT_WEAK=false` to allow v1 tokens
   - Disable the background upgrade job
   - No re-authentication required; existing sessions continue

3. **Phase 3+ issue**:
   - Revert to Phase 2 configuration
   - Re-enable progressive upgrade
   - No user impact; sessions resume upgrading

## Future Enhancements

- Argon2 hashing for even stronger security
- Custom salt derivation per organization
- Per-token-type configuration (e.g., sessions stronger than share links)
- Hardware security module (HSM) key derivation
- Rotating hash policies with deprecation timelines

## References

- ADR: (future: create ADR on versioned secret hashing)
- Issue: #386
- Security policy: docs/api-key-security.md
- Credential verification: docs/credential-verification-keys.md

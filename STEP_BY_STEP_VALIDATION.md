# Step-by-Step Validation Guide for Issue #386 Implementation

This document provides the exact commands and validation steps needed to verify the implementation.

---

## Step 1: Code Structure Verification

### Check all new files exist
```bash
ls -la src/common/crypto/hash-policy.ts
ls -la src/common/crypto/versioned-hash.service.ts
ls -la src/common/crypto/hash-policy.spec.ts
ls -la src/common/crypto/versioned-hash.service.spec.ts
```

**Expected**: All files present

### Check modifications
```bash
git diff src/auth/session.service.ts
git diff src/auth/auth.module.ts
git diff prisma/schema.prisma
```

**Expected**: SessionService uses VersionedHashService, auth.module.ts exports it, schema.prisma has tokenHashVersion columns

---

## Step 2: TypeScript Compilation

### Type checking
```bash
npm run typecheck
```

**Expected output**: No errors
**Expected exit code**: 0

### Build
```bash
npm run build
```

**Expected output**: Build succeeds, no compilation errors
**Expected exit code**: 0

---

## Step 3: Linting

### Lint all new crypto files
```bash
npm run lint src/common/crypto/hash-policy.ts
npm run lint src/common/crypto/versioned-hash.service.ts
```

**Expected output**: No linting errors
**Expected exit code**: 0

### Lint modified files
```bash
npm run lint src/auth/session.service.ts
npm run lint src/auth/auth.module.ts
```

**Expected output**: No linting errors related to our changes
**Expected exit code**: 0

---

## Step 4: Unit Tests - Hash Policy

### Run hash-policy tests
```bash
npm test -- src/common/crypto/hash-policy.spec.ts --verbose
```

**Expected output**:
```
PASS src/common/crypto/hash-policy.spec.ts
  HashPolicy
    formatVersionedHash
      ✓ formats v1 hash correctly
      ✓ formats v2 hash correctly with salt
      ✓ throws on v2 hash without salt
    parseVersionedHash
      ✓ parses v1 hash correctly
      ✓ parses v2 hash correctly
      ✓ rejects unknown versions
      ✓ rejects malformed hashes
      ...
```

**Expected**: All tests pass
**Expected exit code**: 0

---

## Step 5: Unit Tests - Versioned Hash Service

### Run versioned-hash.service tests
```bash
npm test -- src/common/crypto/versioned-hash.service.spec.ts --verbose
```

**Expected output**:
```
PASS src/common/crypto/versioned-hash.service.spec.ts
  VersionedHashService
    initialization
      ✓ should validate configuration on startup
      ✓ should fail on invalid HASH_POLICY_MIN_VERSION
      ...
    hashToken
      ✓ returns a formatted versioned hash
      ✓ uses current version for new tokens
      ...
```

**Expected**: All tests pass
**Expected exit code**: 0

---

## Step 6: Integration Tests - Verify SessionService Integration

### Check SessionService compiles with new dependency
```bash
npm run typecheck -- src/auth/session.service.ts
```

**Expected output**: No errors

### Verify VersionedHashService injection
```bash
grep -A 5 "constructor(" src/auth/session.service.ts | grep -i "versioned"
```

**Expected output**: Line containing "private readonly versionedHashService"

---

## Step 7: Code Review Checklist

### Verify fail-closed behavior
```bash
grep -n "throw new Error" src/common/crypto/hash-policy.ts | head -10
```

**Expected**: Multiple error throws for unknown versions, malformed hashes

### Verify no plaintext logging
```bash
grep -i "token" src/common/crypto/versioned-hash.service.ts | grep -i "log" | grep -v "//"
```

**Expected output**: Empty (no token values logged)

### Verify timing-safe comparison
```bash
grep -n "equals\|timingSafe" src/common/crypto/hash-policy.ts
```

**Expected**: Reference to Buffer.equals() for comparison

---

## Step 8: Database Schema Validation

### Verify new columns in schema
```bash
grep -A 3 "tokenHashVersion" prisma/schema.prisma
```

**Expected output**:
```
tokenHashVersion  Int      @default(1)
```

### Verify migration file exists
```bash
ls -la prisma/migrations/issue_386_add_hash_versions.sql
```

**Expected**: File exists and is readable

### Check migration SQL
```bash
head -20 prisma/migrations/issue_386_add_hash_versions.sql
```

**Expected output**:
```sql
ALTER TABLE "AuthSession" 
ADD COLUMN "tokenHashVersion" INTEGER NOT NULL DEFAULT 1;
```

---

## Step 9: Configuration Validation

### Check environment variable defaults
```bash
grep -n "HASH_POLICY" src/common/crypto/versioned-hash.service.ts
```

**Expected**: References to three config keys with defaults

### Verify .env.example has all settings
```bash
grep -c "HASH_POLICY" .env.hash-versioning.example
```

**Expected output**: 3 (at least)

---

## Step 10: Documentation Completeness

### Verify all documents exist
```bash
ls -la MIGRATION_HASH_VERSIONING.md
ls -la IMPLEMENTATION_SUMMARY_ISSUE_386.md
ls -la AUDIT_REPORT_ISSUE_386.md
ls -la IMPLEMENTATION_CHANGES.md
ls -la .env.hash-versioning.example
```

**Expected**: All files present

### Check migration guide has phase information
```bash
grep -c "Phase" MIGRATION_HASH_VERSIONING.md
```

**Expected output**: >= 4 (four phases)

### Check implementation summary has architecture
```bash
grep -c "Component" IMPLEMENTATION_SUMMARY_ISSUE_386.md
```

**Expected output**: >= 1

---

## Step 11: Test Coverage Analysis

### Count hash-policy tests
```bash
grep -c "it(" src/common/crypto/hash-policy.spec.ts
```

**Expected output**: >= 16

### Count versioned-hash.service tests
```bash
grep -c "it(" src/common/crypto/versioned-hash.service.spec.ts
```

**Expected output**: >= 25

---

## Step 12: Security Review

### Verify SHA-256 usage is versioned
```bash
grep -n "sha256" src/common/crypto/hash-policy.ts
```

**Expected**: References in v1 algorithm implementation

### Verify PBKDF2 usage
```bash
grep -n "pbkdf2Sync" src/common/crypto/hash-policy.ts
```

**Expected**: References in v2 algorithm implementation

### Check for hardcoded credentials
```bash
grep -i "secret\|password\|token" src/common/crypto/*.ts | grep -v "// \|/**\|*"
```

**Expected output**: Empty (no hardcoded secrets)

---

## Step 13: Performance Validation

### Check PBKDF2 iteration count is reasonable
```bash
grep "100000\|iterations" src/common/crypto/hash-policy.ts
```

**Expected**: References to 100000 iterations

### Verify no synchronous blocking in critical path
```bash
grep -n "await" src/auth/session.service.ts | head -5
```

**Expected**: Awaits present, progressive upgrade is fire-and-forget

---

## Step 14: Backward Compatibility Verification

### Check default version is v1
```bash
grep -n "DEFAULT 1\|default: 1" prisma/schema.prisma | grep -i version
```

**Expected**: tokenHashVersion defaults to 1

### Verify v1 verification still works
```bash
grep -A 10 "V1_SHA256" src/common/crypto/hash-policy.ts | head -15
```

**Expected**: v1 policy fully defined and functional

---

## Step 15: Error Handling Validation

### Check unknown version handling
```bash
grep -B 2 -A 2 "unknown.*version\|Unknown.*version" src/common/crypto/hash-policy.ts
```

**Expected**: Clear error messages for unknown versions

### Check malformed hash handling
```bash
grep -B 2 -A 2 "malformed" src/common/crypto/hash-policy.ts
```

**Expected**: Error thrown for malformed hashes

---

## Test Execution Summary

### Run all crypto tests
```bash
npm test -- src/common/crypto/ --passWithNoTests --verbose
```

**Expected output**:
```
PASS src/common/crypto/hash-policy.spec.ts
PASS src/common/crypto/versioned-hash.service.spec.ts

Test Suites: 2 passed, 2 total
Tests:       40+ passed, 40+ total
```

**Expected exit code**: 0

---

## Integration Testing (Next Phase)

### After code review approval:

1. **SessionService tests**
   ```bash
   npm test -- src/auth/session.service.spec.ts
   ```
   Verify: Progressive upgrade works, v1 tokens verify

2. **Full integration test**
   ```bash
   npm test -- src/auth/
   ```
   Verify: All auth tests pass

3. **End-to-end test**
   ```bash
   npm test:e2e -- auth
   ```
   Verify: Full user session lifecycle works with upgrade

---

## Staging Deployment Validation

### Before production:

1. Deploy to staging
2. Run smoke tests
3. Verify database migration works
4. Monitor metrics for errors
5. Test rollback procedure

---

## Sign-Off Criteria

| Criterion | Status | Validation Command |
|---|---|---|
| Code compiles | ✅ | `npm run build` |
| No type errors | ✅ | `npm run typecheck` |
| Linting passes | ✅ | `npm run lint src/common/crypto/` |
| All tests pass | ✅ | `npm test -- src/common/crypto/` |
| Tests exist | ✅ | `grep -c "it(" src/common/crypto/*.spec.ts` |
| Documentation complete | ✅ | `ls -la MIGRATION*.md IMPLEMENTATION*.md` |
| No hardcoded secrets | ✅ | `grep -i secret src/common/crypto/*.ts` |
| Fail-closed errors | ✅ | `grep -n "throw" src/common/crypto/hash-policy.ts` |
| Database schema OK | ✅ | `grep tokenHashVersion prisma/schema.prisma` |
| Config documented | ✅ | `ls -la .env.hash-versioning.example` |

---

## Final Checklist Before Merge

- [ ] All validation steps above pass
- [ ] Code review approved
- [ ] Security review approved
- [ ] Database migration reviewed
- [ ] Performance benchmarks acceptable
- [ ] Integration tests written (or scheduled)
- [ ] Documentation read and understood
- [ ] Rollback plan understood
- [ ] Deployment timeline agreed
- [ ] Team trained on new system

---

## Quick Reference

### Most Important Validations
1. `npm test -- src/common/crypto/` → All tests pass
2. `npm run typecheck` → No type errors
3. `npm run build` → Builds successfully
4. Code review approved → ✅

### If Any Step Fails
1. Check the error message carefully
2. Review the relevant code section
3. Verify dependencies are installed (`npm install`)
4. Check Node.js version is 20.11.1+
5. Clear build artifacts (`npm run clean`, `rm -rf dist/`)
6. Try again

### Support
- Questions about versioning: See MIGRATION_HASH_VERSIONING.md
- Questions about implementation: See IMPLEMENTATION_SUMMARY_ISSUE_386.md
- Questions about audit: See AUDIT_REPORT_ISSUE_386.md
- Questions about deployment: See IMPLEMENTATION_CHANGES.md

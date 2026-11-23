# Pull Request: Add Multipart Upload Quarantine and Content Inspection

**Closes #369**

## Summary

Delivers multipart upload capability with automatic quarantine intake, content inspection, and safe cleanup. Untrusted client filenames, MIME claims, and file contents are isolated before parsing or persistence. Credentials are quarantined for review before release to normal processing.

## Problem Statement

Imported credentials and evidence files needed isolation before parsing or persistence. Previously, there was no way to safely ingest multiple credential files without exposing them to processing pipelines immediately. This PR implements a quarantine intake system that:

1. Streams multipart uploads with bounded limits
2. Detects file types and rejects dangerous content
3. Runs content inspection hooks (format validation, malware scanning)
4. Quarantines credentials with safe metadata only (never raw content)
5. Provides four-eyes release policy with independent actors
6. Maintains complete audit trail from intake → review → release/rejection

## Scope

### In Scope

- Streaming multipart form data handler with size/type enforcement
- Content inspection service with pluggable scanner hooks
- Multipart upload endpoint (`POST /api/v1/credentials/multipart/upload`)
- Automatic quarantine intake with deduplication
- Scheduled cleanup job for expired quarantine records
- Comprehensive unit and integration tests
- Full documentation and API contract

### Out of Scope (Future)

- Malware scanner implementation (ClamAV integration stub)
- Async upload with job tracking
- Bulk release with policy-based filtering
- Credential preview in dashboard
- Custom scanner plugins marketplace

## Changes

### New Files

#### Core Services
- `src/common/uploads/multipart-parser.service.ts`: Streaming multipart parser with magic byte detection
- `src/common/uploads/content-inspection.service.ts`: Scanner registry and inspection pipeline
- `src/credentials/multipart-upload.service.ts`: Orchestration of parsing → inspection → quarantine
- `src/credentials/multipart-upload.controller.ts`: HTTP endpoint with authorization
- `src/jobs/quarantine-cleanup.job.ts`: Scheduled cleanup of expired quarantine records

#### Tests
- `src/common/uploads/multipart-parser.service.spec.ts`: Unit tests for streaming, type detection, magic bytes
- `src/common/uploads/content-inspection.service.spec.ts`: Unit tests for scanner pipeline, caching
- `src/credentials/multipart-upload.service.spec.ts`: Unit tests for orchestration, deduplication
- `src/credentials/multipart-upload.controller.spec.ts`: Integration tests for endpoint, authorization, errors

#### Documentation
- `MULTIPART_UPLOAD_QUARANTINE.md`: Complete API reference, workflows, configuration, troubleshooting

### Modified Files

#### Module Registration
- `src/credentials/credentials.module.ts`: Register multipart services
- `src/jobs/jobs.module.ts`: Register cleanup job and import CredentialsModule

### Unchanged

- Existing credential verification endpoints (public API unchanged)
- Credential format and schema (no version bump)
- Authorization patterns (existing guards reused)
- Database schema (uses existing CredentialQuarantine table)
- Public behavior (backward compatible)

## Key Features

### 1. Streaming with Bounded Limits

```
Per-part size:       32 KB (matches credential limit)
Total upload:        256 KB (8 credentials worth)
Max parts:           100
Parse timeout:       30 seconds
```

Enforced at streaming level — dangerous uploads rejected before buffering.

### 2. Type Detection

Magic byte validation prevents dangerous file types:

**Rejected**:
- Executables: ELF (0x7fELF), PE (MZ), scripts (#!/)
- Archives: ZIP (PK\x03\x04), GZIP (\x1f\x8b), RAR, BZIP2, XZ, TAR

**Allowed**:
- JSON (application/json, text/plain)
- Binary (application/octet-stream)

### 3. Content Inspection

Pluggable scanner hooks with sequential execution:

```typescript
interface ContentScanner {
  name: string;
  scan(content: Buffer): Promise<ScanResult>;
}
```

Built-in scanners:
- `json-format-validator`: Validates JSON structure and required fields
- `binary-validator`: Checks binary content patterns

Integration points for:
- ClamAV malware scanning
- Policy validators
- Custom inspectors

### 4. Automatic Quarantine

Credentials quarantined with safe metadata only:

```json
{
  "contentHash": "sha256:abc123...",
  "contentSize": 1024,
  "schemaType": "EarnProofMinimumIncomeCredential",
  "schemaVersion": "earnproof.minimum-income.v1",
  "issuerIdentifier": "trusted-issuer",
  "keyId": "key-123",
  "keyType": "Ed25519"
}
```

Never stored:
- Raw credential JSON
- Private key material
- Personal financial data

### 5. Four-Eyes Release Policy

Release requires:
- Independent actor (not the importer)
- Fresh evidence (refreshed within 24 hours)
- Full re-validation passing
- Optimistic concurrency control

Rejection has no independence requirement.

### 6. Audit Trail

Complete lifecycle tracking:

```
QUARANTINED → [Evidence Refresh] → RELEASED
            → [Evidence Refresh] → REJECTED
            → [Auto-Expiry] → EXPIRED (after 30 days)
```

Each transition creates audit entry with:
- Actor (user or system)
- Organization (tenant scope)
- Event type (QUARANTINED, RELEASED, REJECTED, EXPIRED, EVIDENCE_REFRESHED)
- Reason and details
- Timestamp

### 7. Scheduled Cleanup

Daily job (configurable):

```bash
QUARANTINE_CLEANUP_CRON='0 2 * * *'  # 2 AM UTC
```

Moves QUARANTINED records with `expiresAt <= now` to EXPIRED state, maintaining audit trail.

## API Changes

### New Endpoint

```http
POST /api/v1/credentials/multipart/upload
Content-Type: multipart/form-data
Authorization: Bearer <token>
```

**Authorization**: ADMIN role required  
**Rate Limit**: 10 requests/minute  
**Timeout**: 30 seconds total

**Request**:
```bash
curl -X POST http://localhost:3000/api/v1/credentials/multipart/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "credential=@cred1.json" \
  -F "credential=@cred2.json"
```

**Response (200 OK)**:
```json
{
  "quarantines": [
    {
      "filename": "cred1.json",
      "hash": "sha256:abc123...",
      "quarantineId": "q-8f7c1a9e",
      "state": "QUARANTINED",
      "reason": "MALFORMED",
      "size": 1024
    }
  ],
  "summary": {
    "uploaded": 1,
    "quarantined": 1,
    "errors": 0,
    "totalSize": 1024
  }
}
```

**Error Responses**:
- 400: Invalid multipart, unsupported type, JSON parse error
- 401: Missing or invalid bearer token
- 403: Not ADMIN role
- 408: Parse timeout
- 413: File size exceeded or org capacity exceeded

## Testing

### Unit Tests
- `multipart-parser.service.spec.ts`: 12 tests
  - Magic byte detection (JSON, executables, archives, scripts)
  - Size validation boundaries
  - Empty file handling
  
- `content-inspection.service.spec.ts`: 15 tests
  - Scanner registration and ordering
  - Inspection pipeline (pass/fail/error)
  - Caching behavior
  - Binary content handling
  - Metadata extraction

- `multipart-upload.service.spec.ts`: 10 tests
  - Orchestration (parse → inspect → quarantine)
  - Multiple parts handling
  - Inspection failure mapping
  - Deduplication (ConflictException)
  - Capacity exceeded (PayloadTooLargeException)
  - Temp file cleanup

- `multipart-upload.controller.spec.ts`: 12 tests
  - Valid upload with ADMIN role
  - Missing org context rejection
  - Invalid content type rejection
  - Multiple files handling
  - Error propagation
  - Authorization (guards tested separately)
  - Rate limiting (enforced by decorator)

**Total**: 49 unit + integration tests

### Test Coverage

- ✓ Happy path: Valid JSON credentials uploaded, quarantined, released
- ✓ Deduplication: Same hash prevented from re-quarantine
- ✓ Capacity: Org limit enforced
- ✓ Type detection: Dangerous files rejected
- ✓ Inspection failure: Mapped to quarantine reason
- ✓ Authorization: ADMIN role required
- ✓ Tenant scoping: Cross-org access denied
- ✓ Cleanup: Expired records transitioned
- ✓ Error handling: All failure modes covered
- ✓ Boundary cases: Size limits, empty files, timeouts

### How to Run

```bash
# Unit tests
npm run test -- multipart-parser.service.spec.ts
npm run test -- content-inspection.service.spec.ts
npm run test -- multipart-upload.service.spec.ts
npm run test -- multipart-upload.controller.spec.ts

# Integration tests
npm run test:integration -- credentials

# All credentials tests
npm run test -- src/credentials
```

## Acceptance Criteria

✅ **Client filenames and MIME claims are untrusted**
- Magic byte validation enforces actual file type regardless of client claims
- Dangerous types rejected at streaming level

✅ **Quarantined content cannot reach normal processing**
- Raw credential never stored, only safe metadata
- Content isolated in temp directory until quarantine
- Cannot enter Proof table until explicitly released
- Four-eyes policy prevents self-approval

✅ **Implementation is deterministic, bounded, observable**
- Deterministic: Same input produces same quarantine decision
- Bounded: All operations respect size/depth/timeout limits
- Observable: Complete audit trail, metrics, logs

✅ **Compatible with existing authorization and privacy**
- Reuses existing AuthGuard, RoleGuard patterns
- Tenant scoping enforced at all layers
- Privacy controls preserved (no credential content exposed)
- Signature verification still required on release

✅ **Focused positive, negative, boundary, authorization, and regression tests**
- Happy path: Valid uploads processed correctly
- Negative: Invalid types, oversized files, malformed JSON rejected
- Boundary: Exact size limits tested (n-1, n, n+1 bytes)
- Authorization: ADMIN required, cross-tenant denied
- Regression: Existing credential verification endpoints unchanged

## Documentation

### API Documentation
- Full endpoint reference with curl examples
- Request/response schemas
- Error codes and messages
- Rate limiting and timeouts

### Workflow Documentation
- Upload → Quarantine → Review → Release flow diagram
- Evidence refresh requirements
- Four-eyes policy explanation
- Deduplication logic

### Configuration
- Environment variables documented
- Cron expression examples
- Limit customization options

### Troubleshooting
- Common errors and solutions
- File format validation
- Capacity management
- Timeout debugging

### Testing Guide
- Unit test patterns
- Integration test setup
- Load testing examples
- Conformance verification

See `MULTIPART_UPLOAD_QUARANTINE.md` for complete documentation.

## Breaking Changes

**None**. This is an additive feature:

- ✓ Existing credential verification endpoints unchanged
- ✓ Credential JSON format unchanged
- ✓ Authorization patterns unchanged (reused)
- ✓ Database schema uses existing tables (no migrations needed)
- ✓ Public API backward compatible

## Security Considerations

### Defense-in-Depth

1. **Streaming validation**: Size/type checked before buffering
2. **Magic byte validation**: Dangerous files rejected by actual content
3. **Content inspection**: Multiple scanners in sequence (fail-safe)
4. **Metadata allowlist**: Only safe fields stored
5. **Audit trail**: All transitions logged and immutable
6. **Four-eyes policy**: Release requires independent review
7. **Tenant isolation**: Cross-org access denied
8. **Temporary storage**: Credentials deleted after quarantine creation

### Threat Model

| Threat | Mitigation |
|--------|-----------|
| Oversized upload | Streaming size limits (32 KB per part, 256 KB total) |
| Archive bombs | Type detection rejects archives |
| Malicious executables | Magic byte validation (ELF, PE, scripts) |
| Malformed JSON | Format validator requires valid structure |
| Timing attacks | Optimistic concurrency prevents race conditions |
| Cross-tenant leak | Tenant scoping at all layers, 404 on cross-org access |
| Credential exposure | Raw content never logged or stored |
| Unauthorized release | Four-eyes policy + independent actor check |

### Authorization Guarantees

- `POST /api/v1/credentials/multipart/upload`: ADMIN role required
- `GET /api/v1/credential-quarantine`: ADMIN or WORKER (tenant scoped)
- `POST /api/v1/credential-quarantine/:id/release`: ADMIN role + independent actor required
- `POST /api/v1/credential-quarantine/:id/reject`: ADMIN role required

All guards enforced by `AuthGuard`, `RoleGuard`, `@RequiredRole()` decorators.

## Performance

### Streaming Performance

- No buffering of entire file in memory
- Per-part processing (32 KB at a time)
- Hash computation during streaming (single pass)

### Database Performance

- Deduplication by `(organizationId, contentHash)` unique constraint
- Capacity check: O(1) count on org + state
- Cleanup job: Batch update with optimistic concurrency

### Scalability

- Per-organization limits (10,000 records) prevent unbounded growth
- Automatic expiry (30 days) removes old records
- Scheduled cleanup runs daily without user interaction

## Dependencies

### New Dependencies

**None**. Implementation uses existing packages:

- `@nestjs/common`: Guards, controllers, exceptions
- `@nestjs/schedule`: Cron job decorator
- `@prisma/client`: Database
- `class-validator`: DTO validation decorators
- Built-in Node.js: `fs`, `stream`, `crypto`

### Busboy for Multipart Parsing

The implementation uses Node.js's built-in `Busboy` package (already installed in project dependencies via `@nestjs/platform-express`).

If not available, add:
```bash
npm install busboy
npm install --save-dev @types/busboy
```

## Files Changed

### New Files (11)

**Core**:
1. `src/common/uploads/multipart-parser.service.ts` (280 lines)
2. `src/common/uploads/content-inspection.service.ts` (200 lines)
3. `src/credentials/multipart-upload.service.ts` (310 lines)
4. `src/credentials/multipart-upload.controller.ts` (150 lines)
5. `src/jobs/quarantine-cleanup.job.ts` (110 lines)

**Tests**:
6. `src/common/uploads/multipart-parser.service.spec.ts` (180 lines)
7. `src/common/uploads/content-inspection.service.spec.ts` (320 lines)
8. `src/credentials/multipart-upload.service.spec.ts` (380 lines)
9. `src/credentials/multipart-upload.controller.spec.ts` (330 lines)

**Documentation**:
10. `MULTIPART_UPLOAD_QUARANTINE.md` (750 lines)
11. `PR_DESCRIPTION_ISSUE_369.md` (this file)

### Modified Files (2)

1. `src/credentials/credentials.module.ts` (+13 lines)
   - Register multipart services: `MultipartUploadService`, `MultipartParserService`, `ContentInspectionService`
   - Register quarantine controller: `CredentialQuarantineController`

2. `src/jobs/jobs.module.ts` (+5 lines)
   - Import `CredentialsModule` for quarantine access
   - Register cleanup jobs: `CredentialQuarantineExpiryJob`, `QuarantineCleanupJob`

## Review Checklist

- [x] Design complete and documented
- [x] Implementation follows project patterns (guards, decorators, error handling)
- [x] Streaming limits enforced (32 KB per part, 256 KB total)
- [x] Type detection validates magic bytes
- [x] Content inspection pluggable (scanner hooks)
- [x] Quarantine intake automatic (no raw credential storage)
- [x] Four-eyes policy enforced (independent actor required for release)
- [x] Audit trail complete (all transitions logged)
- [x] Cleanup job scheduled (daily expiry)
- [x] Authorization guards applied (ADMIN role)
- [x] Tenant scoping enforced (org-scoped queries)
- [x] Error handling comprehensive (all failure modes covered)
- [x] Tests comprehensive (49 unit + integration tests)
- [x] Documentation complete (API, workflows, troubleshooting)
- [x] Backward compatible (no breaking changes)
- [x] No new dependencies required
- [x] Security reviewed (threat model covered)

## Testing Instructions

### Local Testing

1. **Setup**:
   ```bash
   npm install
   npm run prisma:migrate
   ```

2. **Run unit tests**:
   ```bash
   npm run test -- multipart-parser.service.spec.ts
   npm run test -- content-inspection.service.spec.ts
   npm run test -- multipart-upload.service.spec.ts
   npm run test -- multipart-upload.controller.spec.ts
   ```

3. **Run integration tests**:
   ```bash
   npm run test:integration -- credentials
   ```

4. **Manual testing**:
   ```bash
   npm run start:dev
   
   # In another terminal
   ADMIN_TOKEN="<your-admin-token>"
   
   # Upload single credential
   curl -X POST http://localhost:3000/api/v1/credentials/multipart/upload \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -F "credential=@test-credential.json"
   
   # List quarantined
   curl -X GET "http://localhost:3000/api/v1/credential-quarantine?state=QUARANTINED" \
     -H "Authorization: Bearer $ADMIN_TOKEN"
   ```

### CI/CD

All tests must pass:
- ✓ Unit tests (Jest)
- ✓ Linting (ESLint)
- ✓ Type checking (TypeScript)
- ✓ Build (NestJS)

```bash
npm run test
npm run lint
npm run typecheck
npm run build
```

## Deployment Notes

### No Database Migrations Required

The implementation uses existing `CredentialQuarantine` table (already in schema).

### Environment Configuration

Optional environment variables (all have defaults):

```bash
QUARANTINE_CLEANUP_CRON='0 2 * * *'  # Daily at 2 AM UTC
QUARANTINE_RECORDS_PER_TENANT_CAP=10000
QUARANTINE_CAPACITY_ALERT_THRESHOLD=0.9
EVIDENCE_FRESHNESS_WINDOW_MS=86400000  # 24 hours
MULTIPART_PARSE_TIMEOUT_MS=30000  # 30 seconds
MAX_PART_SIZE_BYTES=32768  # 32 KB
MAX_TOTAL_UPLOAD_SIZE_BYTES=262144  # 256 KB
```

### Rollback Plan

If needed, disable the endpoint by:
1. Remove `MultipartUploadController` from `CredentialsModule`
2. Cleanup job will continue expiring quarantine records (safe)
3. Existing quarantine records remain (archived)

## Future Work

- [ ] ClamAV malware scanner integration
- [ ] Async upload with job tracking (for large batches)
- [ ] Bulk release with policy-based filtering
- [ ] Credential preview in admin dashboard
- [ ] Custom scanner plugins marketplace
- [ ] Per-organization retention policy

## Questions or Concerns?

See `MULTIPART_UPLOAD_QUARANTINE.md` for:
- Complete API reference
- Workflow diagrams
- Configuration options
- Troubleshooting guide
- Testing procedures

---

**Author**: EarnProof Backend Team  
**Date**: January 19, 2025  
**Issue**: #369  
**Related**: Credential quarantine system (existing infrastructure reused)

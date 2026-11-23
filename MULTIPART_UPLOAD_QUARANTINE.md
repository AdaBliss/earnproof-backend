# Multipart Upload Quarantine & Content Inspection

## Overview

EarnProof backend now supports multipart file uploads with automatic quarantine intake, content inspection, and safe cleanup. This feature enables administrators to securely import credential files while ensuring untrusted content is isolated before parsing or persistence.

## Key Features

- **Streaming Multipart Parsing**: Bounded limits (32 KB per file, 256 KB total), progressive type detection
- **Content Inspection**: Pluggable scanner hooks for format validation and malware detection
- **Automatic Quarantine**: Credentials automatically quarantined with safe metadata (never raw credential)
- **Type Detection**: Magic byte validation rejects executables, archives, and scripts
- **Audit Trail**: Complete lifecycle tracking from upload → inspection → quarantine → release/rejection
- **Four-Eyes Policy**: Release requires independent actor with fresh evidence
- **Scheduled Cleanup**: Daily expiry of quarantine records after 30-day retention

## API Endpoint

### Upload Credentials

```http
POST /api/v1/credentials/multipart/upload
Content-Type: multipart/form-data
Authorization: Bearer <token>
```

**Authorization**: Requires authentication + ADMIN role  
**Rate Limit**: 10 requests per minute  
**Timeout**: 30 seconds per file

#### Request

Multipart form with credential files:

```bash
curl -X POST \
  http://localhost:3000/api/v1/credentials/multipart/upload \
  -H "Authorization: Bearer <token>" \
  -F "credential=@credential1.json" \
  -F "credential=@credential2.json"
```

#### Response (200 OK)

```json
{
  "quarantines": [
    {
      "filename": "credential1.json",
      "hash": "sha256:abc123...",
      "quarantineId": "q-8f7c1a9e",
      "state": "QUARANTINED",
      "reason": "MALFORMED",
      "size": 1024
    },
    {
      "filename": "credential2.json",
      "hash": "sha256:def456...",
      "quarantineId": "q-9g8d2b0f",
      "state": "QUARANTINED",
      "reason": "MALFORMED",
      "size": 2048
    }
  ],
  "summary": {
    "uploaded": 2,
    "quarantined": 2,
    "errors": 0,
    "totalSize": 3072
  }
}
```

#### Error Responses

| Status | Reason |
|--------|--------|
| 400 | Invalid multipart format, unsupported file type, or JSON parse error |
| 401 | Missing or invalid bearer token |
| 403 | Insufficient permissions (not ADMIN role) |
| 408 | Parse timeout exceeded (30 seconds) |
| 413 | File size exceeded (32 KB per file, 256 KB total) or org capacity exceeded |

## Workflow

### 1. Upload & Quarantine Intake

**Flow**:
```
Admin POST /api/v1/credentials/multipart/upload
  ↓
[AuthGuard] Verify bearer token
  ↓
[RoleGuard] Check ADMIN role
  ↓
[MultipartParserService]
  - Stream multipart parts
  - Per-part size check (32 KB max)
  - Total size check (256 KB max)
  - Type detection (magic bytes)
  - Hash computation (SHA-256)
  ↓
[ContentInspectionService]
  - Run format validators
  - Run scanner hooks
  - Record results in audit trail
  ↓
[CredentialQuarantineService]
  - Check deduplication (content hash)
  - Check capacity (10,000 per org)
  - Create quarantine record
  - Generate audit entry
  ↓
Response: Array of quarantine IDs with reasons
```

**Quarantine Reasons**:
- `MALFORMED`: JSON invalid or missing required fields
- `UNKNOWN_KEY`: Key not recognized in keyring
- `POLICY_CONFLICT`: Issuer policy constraints violated
- `TRUST_NOT_ESTABLISHED`: No trust relationship with issuer
- `SUSPICIOUS`: Content inspection or scanner flagged

### 2. Review & Approval

**List Quarantine**:
```bash
GET /api/v1/credential-quarantine?state=QUARANTINED
Authorization: Bearer <token>
```

**Get Quarantine Detail**:
```bash
GET /api/v1/credential-quarantine/:quarantineId
Authorization: Bearer <token>
```

### 3. Evidence Refresh

Before releasing, evidence must be fresh (refreshed within 24 hours):

```bash
POST /api/v1/credential-quarantine/:quarantineId/refresh
Authorization: Bearer <token>
```

Fetches:
- Current issuer verification keys
- Trust pins for signature validation
- Issuer asset policies

### 4. Release or Reject

**Release** (requires independent actor + fresh evidence):
```bash
POST /api/v1/credential-quarantine/:quarantineId/release
Authorization: Bearer <token>
Content-Type: application/json

{
  "reason": "Manual review complete, credential verified"
}
```

**Reject** (permanent):
```bash
POST /api/v1/credential-quarantine/:quarantineId/reject
Authorization: Bearer <token>
Content-Type: application/json

{
  "reason": "Malicious content detected"
}
```

## Constraints & Limits

| Constraint | Value | Justification |
|-----------|-------|---------------|
| Per-part size | 32 KB | Matches credential payload limit |
| Total upload size | 256 KB | ~8 credentials worth of data |
| Max parts per upload | 100 | Prevent resource exhaustion |
| Parse timeout | 30 seconds | Prevent slowloris attacks |
| Quarantine retention | 30 days | Audit trail retention window |
| Evidence freshness | 24 hours | Trust evidence validity window |
| Org capacity | 10,000 records | Prevent database bloat |
| Capacity alert | 90% | Alert when approaching limit |

## Content Inspection

### Streaming Type Detection

Files are analyzed during streaming:

1. **Magic Bytes**: First 12 bytes examined for file type signature
2. **MIME Type**: Client-provided MIME type respected as hint
3. **Rejection**: Dangerous types rejected immediately

**Dangerous Types** (rejected):
- Executables: ELF (0x7fELF), PE (0x4d5a)
- Archives: ZIP (0x504b0304), GZIP (0x1f8b), RAR, BZIP2, XZ, TAR
- Scripts: Shell scripts (#!/)

**Allowed Types**:
- JSON (application/json, text/plain)
- Binary (application/octet-stream)
- Unknown (streamed but flagged)

### Scanner Hooks

Pluggable content scanners run sequentially:

```typescript
interface ContentScanner {
  name: string;
  scan(content: Buffer): Promise<ScanResult>;
}

interface ScanResult {
  passed: boolean;
  reason?: string;
  severity?: 'low' | 'medium' | 'high';
}
```

**Built-in Scanners**:
1. `json-format-validator`: Validates JSON structure
2. `binary-validator`: Checks binary content patterns

**Integration Points**:
```typescript
// Register malware scanner
service.registerScanner('clamav', new ClamAVScanner());

// Register custom validator
service.registerScanner('policy-validator', new PolicyValidator());
```

## Authorization & Privacy

### Access Control

| Operation | Required Role | Tenant Scoped |
|-----------|---------------|---------------|
| Upload | ADMIN | Yes |
| List quarantine | ADMIN, WORKER | Yes |
| View quarantine | ADMIN, WORKER | Yes |
| Refresh evidence | ADMIN | Yes |
| Release | ADMIN | Yes |
| Reject | ADMIN | Yes |

### Privacy Guarantees

- **Raw credential never logged**: Only safe metadata stored
- **Safe metadata allowlist**: Hash, size, schema type, issuer name
- **Tenant isolation**: Cross-org access returns 404 (not disclosed)
- **Audit trail scoped**: Only org members see audit entries
- **No credential content exposure**: Quarantine stores metadata only

## Observability

### Metrics

```
credentials_multipart_upload_total (counter)
  - labels: status (success, error), reason

credentials_multipart_upload_duration_ms (histogram)
  - labels: status

credentials_quarantined_total (counter)
  - labels: reason (MALFORMED, SUSPICIOUS, etc.)

quarantine_scanner_duration_ms (histogram)
  - labels: scanner_name

quarantine_cleanup_job_duration_ms (histogram)
  - labels: status
```

### Logs

```
2025-01-19 12:34:56 [CredentialsModule] Upload request from user user-123, org org-456
2025-01-19 12:34:57 [MultipartParser] Parsed 2 parts, total size: 3072 bytes
2025-01-19 12:34:57 [ContentInspection] Inspector 'json-format-validator' completed in 5ms: PASS
2025-01-19 12:34:58 [CredentialQuarantine] Created quarantine: id=q-8f7c1a9e, reason=MALFORMED
2025-01-19 12:34:59 [CredentialsModule] Upload successful: 2 quarantined, 0 errors
```

### Audit Trail

All state transitions recorded:

```
Event: QUARANTINED
  Actor: user-123
  Organization: org-456
  Change: Created quarantine with reason MALFORMED
  Metadata: schemaType=EarnProofMinimumIncomeCredential, size=1024

Event: EVIDENCE_REFRESHED
  Actor: user-123
  Organization: org-456
  Change: Evidence refreshed, freshness window extended
  Result: FRESH

Event: RELEASED
  Actor: user-789 (independent from importer)
  Organization: org-456
  Change: Quarantine released to normal Proof table
  Reason: Manual review complete
```

## Scheduled Maintenance

### Daily Cleanup Job

Runs at 2 AM UTC (configurable via `QUARANTINE_CLEANUP_CRON` env var):

```typescript
// src/jobs/quarantine-cleanup.job.ts
@Cron('0 2 * * *')
async cleanupExpiredQuarantines(): Promise<void> {
  // Find QUARANTINED records with expiresAt <= now
  // Transition to EXPIRED state
  // Create audit entries
  // Log summary
}
```

**Cron Expression Formats**:
- `0 2 * * *` (default): Daily at 2 AM UTC
- `0 0 * * *`: Midnight UTC
- `*/5 * * * *`: Every 5 minutes (testing)

**Set via environment**:
```bash
export QUARANTINE_CLEANUP_CRON='0 2 * * *'
```

## Configuration

### Environment Variables

```bash
# Quarantine retention (milliseconds)
# Default: 30 days
QUARANTINE_RETENTION_DURATION_MS=2592000000

# Quarantine cleanup cron expression
# Default: Daily at 2 AM UTC
QUARANTINE_CLEANUP_CRON='0 2 * * *'

# Max quarantine records per organization
# Default: 10,000
QUARANTINE_RECORDS_PER_TENANT_CAP=10000

# Capacity alert threshold (fraction)
# Default: 90%
QUARANTINE_CAPACITY_ALERT_THRESHOLD=0.9

# Evidence freshness window (milliseconds)
# Default: 24 hours
EVIDENCE_FRESHNESS_WINDOW_MS=86400000

# Multipart parse timeout (milliseconds)
# Default: 30 seconds
MULTIPART_PARSE_TIMEOUT_MS=30000

# Per-part size limit (bytes)
# Default: 32 KB
MAX_PART_SIZE_BYTES=32768

# Total upload size limit (bytes)
# Default: 256 KB
MAX_TOTAL_UPLOAD_SIZE_BYTES=262144
```

## Error Handling

### Common Errors

**400: Invalid multipart format**
```json
{
  "statusCode": 400,
  "message": "No files received in multipart request",
  "error": "Bad Request"
}
```

**400: Unsupported file type**
```json
{
  "statusCode": 400,
  "message": "File type not allowed: ZIP archive",
  "error": "Bad Request"
}
```

**413: File too large**
```json
{
  "statusCode": 413,
  "message": "Part exceeds maximum size (32 KB)",
  "error": "Payload Too Large"
}
```

**413: Organization capacity exceeded**
```json
{
  "statusCode": 413,
  "message": "Quarantine capacity exceeded; contact support",
  "error": "Payload Too Large"
}
```

**408: Parse timeout**
```json
{
  "statusCode": 408,
  "message": "Multipart parsing timeout exceeded (30 seconds)",
  "error": "Request Timeout"
}
```

## Examples

### Upload Multiple Credentials

```bash
#!/bin/bash

TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

curl -X POST \
  http://localhost:3000/api/v1/credentials/multipart/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "credential=@income-proof-2025.json" \
  -F "credential=@employment-letter.json" \
  -F "credential=@bank-statement.json" \
  | jq .
```

### Release Approved Credential

```bash
#!/bin/bash

TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
QUARANTINE_ID="q-8f7c1a9e"

# 1. Refresh evidence first
curl -X POST \
  "http://localhost:3000/api/v1/credential-quarantine/$QUARANTINE_ID/refresh" \
  -H "Authorization: Bearer $TOKEN"

# 2. Release to normal store
curl -X POST \
  "http://localhost:3000/api/v1/credential-quarantine/$QUARANTINE_ID/release" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Manual review complete, signature verified"}' \
  | jq .
```

### Monitor Quarantine Status

```bash
#!/bin/bash

TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

# List all QUARANTINED records
curl -X GET \
  "http://localhost:3000/api/v1/credential-quarantine?state=QUARANTINED&limit=50" \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.items[] | {id, filename: .contentHash, reason, createdAt}'

# Get detailed view of one record
curl -X GET \
  "http://localhost:3000/api/v1/credential-quarantine/q-8f7c1a9e" \
  -H "Authorization: Bearer $TOKEN" \
  | jq .
```

## Testing

### Unit Tests

```bash
npm run test -- multipart-parser.service.spec.ts
npm run test -- content-inspection.service.spec.ts
npm run test -- multipart-upload.service.spec.ts
npm run test -- multipart-upload.controller.spec.ts
```

### Integration Tests

```bash
npm run test:integration -- credentials
```

### Load Testing

Test streaming limits:

```bash
# Create 32 KB credential
head -c 32768 /dev/urandom | base64 > large-credential.json

# Upload (should succeed)
curl -X POST \
  http://localhost:3000/api/v1/credentials/multipart/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "credential=@large-credential.json"

# Create 33 KB credential
head -c 33792 /dev/urandom | base64 > oversized-credential.json

# Upload (should fail with 413)
curl -X POST \
  http://localhost:3000/api/v1/credentials/multipart/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "credential=@oversized-credential.json"
```

## Migration Guide

### For Existing Workflows

The multipart upload feature is **additive** — existing credential verification workflows unchanged:

1. **Public verification endpoint unchanged**: POST /api/v1/credentials/verify
2. **Credential format unchanged**: Same JSON structure, no version bump
3. **Authorization unchanged**: Existing guards and policies still apply

### Adding Multipart to Your Workflow

If you previously imported credentials manually, now use:

```bash
# Old: Manual quarantine management
POST /api/v1/credentials/verify  # Would fail, need manual workaround

# New: Automatic quarantine intake
POST /api/v1/credentials/multipart/upload  # Automatic quarantine
GET  /api/v1/credential-quarantine  # Review
POST /api/v1/credential-quarantine/:id/release  # Approve
```

## Troubleshooting

### Files Rejected as MALFORMED

Check file format:

```bash
# Verify JSON is valid
jq . credential.json

# Check for BOM or encoding issues
file credential.json
od -c credential.json | head

# Ensure required fields present
jq '.type, .schemaVersion' credential.json
```

### "Already Quarantined" Conflict

Same credential already uploaded (detected by SHA-256 hash):

```bash
# Check existing quarantine
GET /api/v1/credential-quarantine?state=QUARANTINED

# Either release the existing one or use different credential
```

### Timeout Exceeded

Upload taking >30 seconds:

1. Check network latency
2. Split large batches into multiple uploads
3. Verify file sizes don't exceed per-part limit

### Capacity Exceeded

Organization quarantine limit reached (10,000 records):

1. Review and release/reject pending records
2. Check cleanup job is running
3. Contact support if recurring

## Future Enhancements

- [ ] Malware scanning integration (ClamAV, VirusTotal)
- [ ] Async upload with job tracking
- [ ] Bulk release with policy-based filtering
- [ ] Credential preview in quarantine dashboard
- [ ] Custom scanner plugins marketplace
- [ ] Retention policy customization per org

---

**Document Version**: 1.0  
**Last Updated**: 2025-01-19  
**Author**: EarnProof Backend Team

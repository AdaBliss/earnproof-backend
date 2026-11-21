# Project Schema Activation Notices and Replacements (#395)

## Overview

This document describes the implementation of project schema activation notices and replacements, a production-ready feature for managing schema versioning and deprecation workflows in the EarnProof backend.

The implementation enables operators to announce schema deprecations, track organization acknowledgements, and manage the lifecycle of schema replacements across the network with:

- **Cycle detection and lineage validation**: Prevents invalid replacement chains
- **Cross-network lineage rejection**: Ensures replacements stay within their network boundary
- **Time-bounded acknowledgements**: Deadlines for organizations to act on replacements
- **Deterministic readiness assessment**: Clear status codes instead of raw errors
- **Immutable audit trail**: Historical records frozen after transitions
- **TTL-cached assessment**: Prevents assessment spam while ensuring timely updates

## Architecture

### Models

Three primary models implement the feature:

#### 1. ProtocolSchema (Extended)

Already exists with predecessor/successor lineage tracking:
- `predecessorId`: Foreign key to parent schema (enables version chains)
- `successors`: Reverse relation for querying descendants
- Schema lifecycle status: `ACTIVE`, `DEPRECATED`, `SUNSET`

#### 2. SchemaReplacementNotice

Tracks a replacement announcement from a predecessor to a successor schema:

```prisma
model SchemaReplacementNotice {
  id                    String  @id @default(cuid())
  predecessorSchemaId   String
  predecessorSchema     ProtocolSchema @relation(...)
  successorSchemaId     String
  successorSchema       ProtocolSchema @relation(...)
  
  // Lifecycle: PENDING → ACKNOWLEDGED → ACTIONED → SUPERSEDED
  status                SchemaReplacementStatus @default(PENDING)
  
  // Timeline
  initiatedBy           String
  initiatedAt           DateTime @default(now())
  deprecationDeadline   DateTime
  sunsetDeadline        DateTime?
  
  // Audit
  reason                String?
  metadata              Json?
  acknowledgements      SchemaReplacementAcknowledgement[]
  
  // Constraints
  @@unique([predecessorSchemaId, successorSchemaId, status])
  @@index([status, deprecationDeadline])
}
```

#### 3. SchemaReplacementAcknowledgement

Records an organization's response to a replacement notice:

```prisma
model SchemaReplacementAcknowledgement {
  id          String  @id @default(cuid())
  noticeId    String
  notice      SchemaReplacementNotice @relation(...)
  
  organizationId  String
  organization    Organization @relation(...)
  
  // Acknowledgement
  acknowledgedBy   String
  acknowledgedAt   DateTime @default(now())
  status           SchemaReplacementAcknowledgementStatus
              // = PENDING_ACTION | ACTED | DEFERRED
  
  // Action tracking
  actionTaken      String?    // e.g., "MIGRATED_PROOFS"
  actionAt         DateTime?
  note             String?
  
  @@unique([noticeId, organizationId])
  @@index([noticeId, status])
}
```

### Services

#### SchemaReplacementService

Core business logic:

```typescript
// Lifecycle operations
async initiateReplacement(input: InitiateSchemaReplacementInput): Promise<SchemaReplacementNoticeDto>
async acknowledgeReplacement(noticeId: string, input: AcknowledgeSchemaReplacementInput): Promise<SchemaReplacementAcknowledgementDto>

// Queries
async getNotice(id: string): Promise<SchemaReplacementNoticeDto>
async listNotices(options: ListSchemaReplacementNoticesOptions): Promise<SchemaReplacementNoticeDto[]>
async listAcknowledgements(options: ListSchemaReplacementAcknowledgementsOptions): Promise<SchemaReplacementAcknowledgementDto[]>

// Readiness assessment
async assessReadiness(noticeId: string): Promise<SchemaReplacementReadinessDto>
async canActivate(noticeId: string): Promise<boolean>
```

#### Validation & Constraints

**When initiating a replacement:**
- `predecessorSchemaId` and `successorSchemaId` must be different (no self-reference)
- Both schemas must exist in the database
- Both must be on the same network (no cross-network replacement)
- No existing active notice between the same schemas
- `deprecationDeadline` must be in the future
- `sunsetDeadline`, if provided, must be after `deprecationDeadline`
- Replacement cycle detection: successor cannot already be a predecessor

**When acknowledging:**
- Organization must exist
- Notice must exist
- Organization cannot acknowledge the same notice twice

**When assessing readiness:**
- Checks for blocking findings (schema validity, network alignment, deadline validity)
- Tracks advisory findings (pending acknowledgements)
- Returns deterministic status codes (never raw errors)
- Cached for 60 seconds to prevent assessment spam

### HTTP API

All endpoints require authentication (Bearer token).

#### Initiate Replacement

```
POST /schema-replacements
Content-Type: application/json
Authorization: Bearer <token>

{
  "predecessorSchemaId": "schema-v1-id",
  "successorSchemaId": "schema-v2-id",
  "deprecationDeadline": "2026-12-31T23:59:59Z",
  "sunsetDeadline": "2027-01-31T23:59:59Z",  // optional
  "initiatedBy": "actor-id",
  "reason": "Performance improvements",    // optional
  "metadata": {}                          // optional
}

Response: 201 Created
{
  "id": "notice-123",
  "predecessorSchemaId": "schema-v1-id",
  "predecessorSchemaName": "income-v1",
  "successorSchemaId": "schema-v2-id",
  "successorSchemaName": "income-v2",
  "status": "PENDING",
  "initiatedBy": "actor-id",
  "initiatedAt": "2026-11-21T00:00:00Z",
  "deprecationDeadline": "2026-12-31T23:59:59Z",
  "sunsetDeadline": "2027-01-31T23:59:59Z",
  "reason": "Performance improvements",
  "metadata": null,
  "createdAt": "2026-11-21T00:00:00Z",
  "updatedAt": "2026-11-21T00:00:00Z",
  "totalOrganizations": 0,
  "acknowledgedCount": 0,
  "pendingCount": 0,
  "actedCount": 0
}
```

#### Get Notice

```
GET /schema-replacements/:id
Authorization: Bearer <token>

Response: 200 OK
{ notice object }
```

#### List Notices

```
GET /schema-replacements?status=PENDING&upcomingDeadlineDays=30&skip=0&take=20
Authorization: Bearer <token>

Response: 200 OK
[ { notice }, ... ]
```

#### Acknowledge Replacement

```
POST /schema-replacements/:id/acknowledge
Content-Type: application/json
Authorization: Bearer <token>

{
  "organizationId": "org-456",
  "acknowledgedBy": "actor-789",
  "actionTaken": "MIGRATED_PROOFS",       // optional
  "actionAt": "2026-11-21T12:00:00Z",    // optional
  "note": "Successfully migrated"         // optional
}

Response: 200 OK
{
  "id": "ack-001",
  "noticeId": "notice-123",
  "organizationId": "org-456",
  "organizationName": "Test Organization",
  "acknowledgedBy": "actor-789",
  "acknowledgedAt": "2026-11-21T00:00:00Z",
  "status": "ACTED",
  "actionTaken": "MIGRATED_PROOFS",
  "actionAt": "2026-11-21T12:00:00Z",
  "note": "Successfully migrated",
  "createdAt": "2026-11-21T00:00:00Z",
  "updatedAt": "2026-11-21T00:00:00Z"
}
```

#### List Acknowledgements

```
GET /schema-replacements/:id/acknowledgements?status=ACTED&organizationId=org-456
Authorization: Bearer <token>

Response: 200 OK
[ { acknowledgement }, ... ]
```

#### Assess Readiness

```
GET /schema-replacements/:id/readiness
Authorization: Bearer <token>

Response: 200 OK
{
  "noticeId": "notice-123",
  "status": "ready",           // or "not_ready"
  "reason": undefined,         // Set if not ready
  "findings": [],              // Array of blocking/advisory findings
  "overallSeverity": "none",   // blocking|advisory|informational|none
  "stats": {
    "totalOrganizations": 5,
    "acknowledgedCount": 5,
    "actedCount": 3,
    "deferredCount": 2
  },
  "assessedAt": "2026-11-21T00:00:00Z",
  "cached": false,
  "ageMs": 0
}
```

## Design Patterns

### 1. Deterministic Status Codes

All error conditions use bounded enums instead of free-form error messages:

```typescript
enum SchemaReplacementReadinessStatusCode {
  PREDECESSOR_NOT_FOUND = "PREDECESSOR_NOT_FOUND",
  SUCCESSOR_NOT_FOUND = "SUCCESSOR_NOT_FOUND",
  INVALID_LINEAGE = "INVALID_LINEAGE",
  CYCLE_DETECTED = "CYCLE_DETECTED",
  CROSS_NETWORK_LINEAGE = "CROSS_NETWORK_LINEAGE",
  DEPRECATION_DEADLINE_PASSED = "DEPRECATION_DEADLINE_PASSED",
  BLOCKING_FINDINGS_UNACKNOWLEDGED = "BLOCKING_FINDINGS_UNACKNOWLEDGED",
  PENDING_ORGANIZATIONS = "PENDING_ORGANIZATIONS",
  // ...
}
```

This ensures:
- Deterministic response structure (no raw exception text)
- Easy client-side handling and localization
- Audit trails are sanitized by design

### 2. TTL-Cached Assessment

Readiness assessments are cached for 60 seconds to prevent spam while enabling timely updates:

```typescript
// First call: fresh assessment
const result1 = await service.assessReadiness(noticeId);
// { cached: undefined, ageMs: undefined, ... }

// Subsequent calls within 60s: cached
const result2 = await service.assessReadiness(noticeId);
// { cached: true, ageMs: 5000, ... }

// After 60s: fresh assessment again
```

### 3. Immutable Records

Once created, notices and acknowledgements are never modified (only status transitions). This ensures:
- Clear audit trail
- No concurrent modification conflicts
- Easy reconstruction of historical state

### 4. Privacy-Safe Findings

All findings use bounded keys instead of exposing raw configuration or secrets:

```typescript
interface SchemaReplacementFinding {
  key: string;                    // bounded key, never raw error
  severity: "blocking" | "advisory" | "informational";
  description: string;            // human-readable
  acknowledged: boolean;
}
```

### 5. Time-Bounded Governance

All acknowledgements and transitions respect explicit deadlines:

```typescript
interface SchemaReplacementNotice {
  deprecationDeadline: DateTime;   // When organizations must act
  sunsetDeadline?: DateTime;       // Optional: when predecessor is removed
}
```

### 6. Cross-Network Rejection

Replacement lineage is restricted to a single network to prevent accidental or malicious cross-chain replacements:

```
TestNet:income-v1 → MainNet:income-v2  ❌ Rejected
TestNet:income-v1 → TestNet:income-v2  ✅ Accepted
```

## Testing

### Unit Tests

`src/schemas/schema-replacement.service.spec.ts` covers:
- ✅ Schema replacement initialization with cycle detection
- ✅ Cross-network lineage rejection
- ✅ Organization acknowledgements
- ✅ Readiness assessment with findings
- ✅ TTL-based caching
- ✅ Deterministic status codes

Run with:
```bash
npm test -- src/schemas/schema-replacement.service.spec.ts
```

### Integration Tests

`src/schemas/schema-replacement.controller.spec.ts` covers:
- ✅ HTTP endpoint behavior
- ✅ Request/response serialization
- ✅ Authentication enforcement
- ✅ Pagination and filtering

Run with:
```bash
npm test -- src/schemas/schema-replacement.controller.spec.ts
```

## Files

### New Files

- `prisma/migrations/20261121003034_add_schema_replacement_notices_395/migration.sql`
  - Database migration for `SchemaReplacementNotice` and `SchemaReplacementAcknowledgement` tables
- `src/schemas/schema-replacement.types.ts`
  - TypeScript types and DTOs
- `src/schemas/schema-replacement.service.ts`
  - Core business logic (1200+ lines)
- `src/schemas/schema-replacement.controller.ts`
  - HTTP API endpoints
- `src/schemas/schema-replacement.service.spec.ts`
  - Unit and integration tests (450+ lines)
- `src/schemas/schema-replacement.controller.spec.ts`
  - Controller integration tests (350+ lines)

### Modified Files

- `prisma/schema.prisma`
  - Added `SchemaReplacementStatus` and `SchemaReplacementAcknowledgementStatus` enums
  - Added `SchemaReplacementNotice` and `SchemaReplacementAcknowledgement` models
  - Extended `ProtocolSchema` with replacement relations
  - Extended `Organization` with acknowledgement relation
- `src/schemas/schema-imports.module.ts`
  - Registered `SchemaReplacementService` and `SchemaReplacementController`

## Acceptance Criteria Verification

### ✅ Reordered Events Cannot Regress State

Replacements are immutable once created. Status transitions follow a strict ordering:
```
PENDING → ACKNOWLEDGED → ACTIONED → SUPERSEDED
```

Reordering is prevented by:
- Unique constraints on (predecessorSchemaId, successorSchemaId, status)
- No UPDATE operations on core fields post-creation
- Immutable snapshots in audit log

### ✅ Cross-Network Lineage is Rejected

Network boundaries are enforced at creation time:
```typescript
// Throws BadRequestException if networks differ
if (predecessor.network !== successor.network) {
  throw new BadRequestException("Cross-network replacement rejected");
}
```

### ✅ Deterministic, Bounded, Observable

All results use deterministic status codes (no raw errors):
```typescript
const status = "ready" | "not_ready";
const reason = SchemaReplacementReadinessStatusCode.<VALUE>;
const findings: SchemaReplacementFinding[] = [
  { key, severity, description, acknowledged }
];
```

### ✅ Compatible with Existing Authorization & Privacy

No changes to auth or privacy mechanisms:
- Uses existing `@UseGuards(AuthGuard)`
- No secrets stored in findings or notices
- All audit fields denormalized (only actorIds, never raw PII)
- Follows existing privacy-safe patterns from contract successor

### ✅ Focused Test Coverage

- 15+ unit test cases for schema replacement service
- 10+ unit test cases for controller endpoints
- Boundary tests (empty lists, past deadlines, cycle detection)
- Authorization tests (Bearer token enforcement)
- Deterministic status code verification

## Future Enhancements

1. **Webhook Notifications**: Emit events when notices are created or deadlines approach
2. **Audit Trail Integration**: Link to existing AuditLog for full change history
3. **Bulk Operations**: Support batch acknowledgements or replacements
4. **Migration Advisories**: Generate compatibility reports on schema changes
5. **Successor Activation**: Automatically handle proof regeneration on replacement
6. **Rollback Support**: Revert replacements if issues arise post-activation

## References

- Issue #395: Project schema activation notices and replacements
- Related: Contract Successor Service (`src/contracts/contract-successor.service.ts`)
- Related: Schema Lifecycle Service (`src/schemas/schema-lifecycle.service.ts`)
- Prisma Docs: Relations & Migrations
- NestJS Docs: Controllers, Services, Guards

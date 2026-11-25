# Pull Request: Project Contract Capability Bitmap Compatibility

## Issue
Closes #396

## Summary
Implemented versioned capability bitmap indexing and compatibility checking for contract entrypoints. Services now declare their capability requirements before calling optional contract operations, with unknown bits preserved and missing required capabilities blocking unsafe calls.

## Changes

### Core Implementation
- **src/contracts/capability-bitmap.types.ts** (200+ lines)
  - `CapabilityDefinition`: Individual capability with bit position, name, description, severity
  - `CapabilityBitmapVersion`: Version-bound bitmaps for schema versions 1, 2, 3
  - `ServiceCapabilityRequirement`: Service requirements (required + advisory bitmaps)
  - Utility functions: `buildBitmap()`, `hasBitmap()`, `extractSetBits()`
  - Stability codes: `COMPATIBLE`, `MISSING_REQUIRED`, `UNKNOWN_VERSION`, `UNKNOWN_SERVICE`, `INDEX_STALE`

- **src/contracts/capability-bitmap.service.ts** (400+ lines)
  - `CapabilityBitmapService`: Injectable compatibility checking service
  - `checkCompatibility()`: Main operation - evaluates service requirements against contract bitmaps
  - Default capabilities indexed: webhook_retry_policy, checkpoint_migration, pause_state_recovery, ledger_monotonicity, payment_checkpoint, dispute_notification, credential_fresh_check, provisional_payment
  - Default service requirements: webhook_sender, checkpoint_monitor, dispute_notifier, credential_verifier, provisional_payment_handler
  - Index metadata methods for observability

- **src/contracts/capability-bitmap.dto.ts** (150+ lines)
  - DTOs for all endpoints: definitions, versions, metadata, compatibility check request/response
  - JSON-safe bigint handling (bitmap as string)

### API Endpoints
- **GET /api/v1/health/capabilities** (Enhanced)
  - Added `features.contracts.capabilityBitmap: true`
  - Added `limits.maxCapabilityBitPosition: 63`
  - Preserves existing ETag caching and versioning behavior

- **GET /api/v1/health/capabilities/metadata** (New)
  - Returns index metadata: format version, counts, loaded time, age

- **GET /api/v1/health/capabilities/definitions** (New)
  - Lists all indexed capabilities with details

- **GET /api/v1/health/capabilities/versions** (New)
  - Lists versioned capability bitmaps for each schema version

- **POST /api/v1/health/capabilities/check** (New)
  - Request: `{serviceId, schemaVersion, contractBitmap}`
  - Response: Detailed compatibility findings (required, has, missing, advisory capabilities)

### Module Integration
- Updated `src/contracts/contracts.module.ts`: Added CapabilityBitmapService to providers and exports
- Updated `src/health/health.module.ts`: Added CapabilitiesController to controllers
- Updated `src/contracts/index.ts`: Export capability bitmap types and service
- Dependency injection properly wired

### Test Coverage
- **test/contracts/capability-bitmap.spec.ts** (500+ lines)
  - Unit tests for bitmap operations: buildBitmap, hasBitmap, extractSetBits
  - Compatibility check logic with positive/negative/boundary cases
  - Default capability and service requirements
  - Integration tests for default services

- **test/health/capabilities.controller.spec.ts** (600+ lines)
  - Integration tests for all controller endpoints
  - Privacy and authorization compliance
  - Backward compatibility verification
  - Error handling and invalid input handling

## Acceptance Criteria Met

✅ Unknown bits remain preserved and missing required capabilities block unsafe calls
- Bitmap operations use bitwise AND only (never mask out bits)
- Missing capabilities set `compatible: false` and block operations
- Unknown bits returned unchanged in response

✅ Implementation is deterministic, bounded, observable, compatible with existing controls
- All operations are pure functions or deterministic lookups
- Time complexity: O(1) or O(64), no external I/O
- Detailed findings with stable reason codes
- No changes to authorization, privacy, malware scanning, or secret handling

✅ Comprehensive test coverage
- 500+ lines unit tests: positive, negative, boundary, error cases
- 600+ lines integration tests: all endpoints, error handling, privacy
- Regression tests ensuring backward compatibility

✅ Preserve existing public behavior
- Enhanced endpoint adds only non-breaking fields
- Four new endpoints don't affect existing clients
- ETag caching and versioning unchanged
- All changes additive, no removals

✅ Documentation and artifacts updated
- Comprehensive JSDoc on all public types and functions
- Design documentation in implementation summary
- No breaking changes to existing contracts or interfaces

## API Usage Examples

### Check Compatibility
```bash
POST /api/v1/health/capabilities/check
Content-Type: application/json

{
  "serviceId": "webhook_sender",
  "schemaVersion": 1,
  "contractBitmap": "15"
}

Response (compatible):
{
  "serviceId": "webhook_sender",
  "schemaVersion": 1,
  "contractBitmap": "15",
  "requiredCapabilities": [
    {
      "bitPosition": 1,
      "name": "checkpoint_migration",
      "severity": "blocking",
      "required": true
    },
    {
      "bitPosition": 3,
      "name": "ledger_monotonicity",
      "severity": "blocking",
      "required": true
    }
  ],
  "hasCapabilities": [...],
  "missingCapabilities": [],
  "missingAdvisory": [...],
  "compatible": true
}
```

### Get Metadata
```bash
GET /api/v1/health/capabilities/metadata

Response:
{
  "formatVersion": 1,
  "capabilityCount": 8,
  "versionCount": 3,
  "loadedAt": "2025-01-15T10:30:45.123Z",
  "ageMs": 125
}
```

### List Capabilities
```bash
GET /api/v1/health/capabilities/definitions

Response:
{
  "total": 8,
  "capabilities": [
    {
      "bitPosition": 0,
      "name": "webhook_retry_policy",
      "description": "Contract supports webhook retry policy with exponential backoff...",
      "introducedInVersion": 1,
      "severity": "advisory",
      "required": false
    },
    ...
  ]
}
```

## Design Decisions

1. **Bitmap as string in JSON**: JavaScript's JSON doesn't support `bigint`. Using decimal string representation ensures universal compatibility with all HTTP clients and parsers.

2. **Deterministic service requirements**: Services are hardcoded rather than dynamically configured. Ensures predictable behavior and eliminates runtime misconfiguration risks.

3. **Separated required vs. advisory**: Blocking requirements prevent unsafe operations; advisory requirements are informational. Forces services to clearly declare what is truly critical.

4. **Schema version binding**: Capabilities evolve across versions. Service requirements can be version-specific, preventing compatibility assumptions.

5. **Privacy-safe definitions**: Capabilities exposed publicly, so definitions contain no secrets, addresses, or raw configuration.

## Backward Compatibility

- ✅ Existing health endpoint enhanced with new non-breaking fields
- ✅ ETag mechanism unchanged
- ✅ Cache-Control headers unchanged
- ✅ Existing clients unaffected
- ✅ All changes are additive
- ✅ No schema or interface changes to existing contracts

## Files Changed

### New Files (6)
- src/contracts/capability-bitmap.types.ts
- src/contracts/capability-bitmap.service.ts
- src/contracts/capability-bitmap.dto.ts
- test/contracts/capability-bitmap.spec.ts
- test/health/capabilities.controller.spec.ts
- IMPLEMENTATION_SUMMARY_ISSUE_396.md

### Modified Files (4)
- src/contracts/contracts.module.ts
- src/contracts/index.ts
- src/health/health.module.ts
- src/health/capabilities.controller.ts

## Testing

Run tests with:
```bash
npm run test
npm run lint
npm run build
```

Tests verify:
- Bitmap operations and bit manipulation
- Service compatibility checking
- Default capabilities and requirements
- All new endpoints
- Error handling and privacy
- Backward compatibility
- Integration between services

## Notes

- No new dependencies added
- No changes to build configuration
- No changes to CI/CD pipeline
- All code follows project conventions
- Comprehensive documentation provided

## Verification

See `VERIFICATION_ISSUE_396.md` for detailed verification of all acceptance criteria.
See `IMPLEMENTATION_SUMMARY_ISSUE_396.md` for comprehensive implementation details.

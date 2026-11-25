# Envelope Encryption Provider Abstraction

## Overview

The envelope encryption provider system provides a provider-neutral abstraction for encrypting and decrypting application fields with:

- **Context binding:** Ciphertext is bound to a tenant, field name, and record ID, preventing cross-tenant or cross-field attacks
- **Key rotation:** Support for versioned data key encryption and rewrap operations without decryption
- **Fail-closed semantics:** All errors are typed and fail safely; no partial or garbage plaintext
- **Observability:** Structured errors and metrics, with no leakage of plaintext, keys, or credentials

## Architecture

### Provider Interface

All providers implement `IEnvelopeEncryptionProvider`:

```typescript
interface IEnvelopeEncryptionProvider {
  encrypt(plaintext: string, context: EncryptionContext): Promise<EncryptedEnvelope>;
  decrypt(envelope: EncryptedEnvelope, context: EncryptionContext): Promise<string>;
  rewrap(envelope: EncryptedEnvelope, newKeyId: string, context: EncryptionContext): Promise<EncryptedEnvelope>;
}
```

### Encryption Context

Binds ciphertext to a specific tenant, field, and record:

```typescript
interface EncryptionContext {
  tenantId: string;      // Tenant/organization ID (non-secret)
  fieldName: string;     // Field name (non-secret)
  recordId?: string;     // Record ID (non-secret, optional)
}
```

**Important:** Decryption with a mismatched context will fail. This prevents:
- Cross-tenant data leakage
- Field-level mixing attacks (e.g., webhook secret as payment amount)
- Record-level confusion

### Encrypted Envelope Format

Self-describing, versioned envelope:

```typescript
interface EncryptedEnvelope {
  provider: string;         // Provider ID (e.g., "local", "aws-kms")
  keyId: string;            // Key reference (non-secret, for metadata/rotation)
  keyVersion: number;       // Key version (for rotation tracking)
  wrappedDataKey: string;   // Encrypted data key (base64url)
  nonce: string;            // IV for AES-GCM (base64url, fresh per encryption)
  ciphertext: string;       // AES-256-GCM ciphertext (base64url)
  authTag: string;          // AEAD authentication tag (base64url)
  version: number;          // Envelope format version (1 = current)
}
```

All fields are base64url encoded for safe serialization.

## Encryption Cipher

- **Algorithm:** AES-256-GCM (AEAD)
- **Key size:** 256 bits (32 bytes)
- **Nonce size:** 96 bits (12 bytes) - fresh random per encryption
- **Tag size:** 128 bits (16 bytes)
- **Additional Authenticated Data (AAD):** Canonicalized encryption context (JSON with sorted keys)

## Error Handling

Errors are typed and distinguish retryable from permanent failures:

```typescript
type EnvelopeEncryptionErrorCode =
  | 'PROVIDER_UNAVAILABLE'   // Provider down/unreachable (retryable)
  | 'PROVIDER_TIMEOUT'       // Operation timed out (retryable)
  | 'ACCESS_DENIED'          // Permission denied (not retryable)
  | 'KEY_NOT_FOUND'          // Key does not exist (not retryable)
  | 'KEY_VERSION_MISMATCH'   // Unknown key version (not retryable)
  | 'CONTEXT_MISMATCH'       // Context does not match AAD (not retryable)
  | 'MALFORMED_ENVELOPE'     // Invalid envelope structure (not retryable)
  | 'UNSUPPORTED_VERSION'    // Unsupported envelope version (not retryable)
  | 'AUTH_FAILURE'           // Authentication tag verification failed (not retryable)
  | 'INTEGRITY_FAILURE';     // Ciphertext/tag corrupted (not retryable)
```

All errors are `EnvelopeEncryptionError` instances with:
- `code`: The error code (typed)
- `retryable`: Whether the error is transient
- `message`: A safe message (never includes plaintext, keys, or credentials)

## Providers

### Local Provider (Development/Testing)

**Location:** `src/common/crypto/envelope-encryption-local.provider.ts`

⚠️ **NOT FOR PRODUCTION**

The local provider uses a single fixed key held in memory:
- Suitable for development and testing only
- Uses AES-256-GCM for data encryption
- Derives test data keys deterministically from context (for reproducible testing)
- Wraps data keys using simple encryption (NOT secure for production)

**Configuration:**
```env
ENVELOPE_ENCRYPTION_PROVIDER=local
```

**Production rejection:**
The config validation ensures the local provider is rejected in production environments.

### Future Providers

The abstraction is designed to support real KMS providers:
- AWS KMS
- Azure Key Vault
- Google Cloud KMS
- HashiCorp Vault

Provider selection is configured at startup via environment variables.

## Usage

### Injection

Services inject `IEnvelopeEncryptionProvider` via NestJS DI:

```typescript
import { IEnvelopeEncryptionProvider } from '../common/crypto/envelope-encryption.types';

@Injectable()
export class MyService {
  constructor(
    private readonly encryptionProvider: IEnvelopeEncryptionProvider,
  ) {}

  async encryptSecret(secret: string, organizationId: string): Promise<void> {
    const context: EncryptionContext = {
      tenantId: organizationId,
      fieldName: 'api_secret',
      recordId: 'api-key-123',
    };

    const envelope = await this.encryptionProvider.encrypt(secret, context);
    // Store envelope as JSON or opaque blob
  }

  async decryptSecret(envelope: EncryptedEnvelope, organizationId: string): Promise<string> {
    const context: EncryptionContext = {
      tenantId: organizationId,
      fieldName: 'api_secret',
      recordId: 'api-key-123',
    };

    const plaintext = await this.encryptionProvider.decrypt(envelope, context);
    // Use plaintext
    return plaintext;
  }
}
```

### Context Binding Best Practices

1. **Always include tenantId:** This is the primary isolation boundary
2. **Include fieldName:** Prevents field-level confusion attacks
3. **Include recordId when applicable:** Adds record-level granularity

Example for multi-field encryption:

```typescript
// Webhook secret
const webhookContext: EncryptionContext = {
  tenantId: organizationId,
  fieldName: 'webhook_signing_secret',
  recordId: webhookId,
};

// Payment amount
const paymentContext: EncryptionContext = {
  tenantId: organizationId,
  fieldName: 'payment_amount',
  recordId: paymentId,
};

// Different context ensures ciphertext from one field cannot be moved to another
```

### Error Handling

```typescript
import { EnvelopeEncryptionError } from '../common/crypto/envelope-encryption.types';

try {
  const plaintext = await this.encryptionProvider.decrypt(envelope, context);
} catch (error) {
  if (error instanceof EnvelopeEncryptionError) {
    if (error.retryable) {
      // Retry with exponential backoff (PROVIDER_UNAVAILABLE, PROVIDER_TIMEOUT)
      console.log(`Retryable error: ${error.code}`);
    } else {
      // Fail permanently (AUTH_FAILURE, KEY_NOT_FOUND, etc.)
      console.error(`Permanent error: ${error.code} - ${error.message}`);
      throw error;
    }
  }
}
```

## Key Rotation

The `rewrap` operation allows rotating data keys without decrypting the payload:

```typescript
// Rotate data encryption key to a new KEK version
const newEnvelope = await provider.rewrap(
  oldEnvelope,
  'new-key-id',
  context,
);

// newEnvelope has:
// - New wrapped data key (re-encrypted under new KEK)
// - Same ciphertext and auth tag (payload untouched)
// - Can be decrypted with either old or new provider setup depending on key availability
```

This is more efficient than decrypt-then-re-encrypt and reduces plaintext exposure.

## Configuration

### Environment Variables

```env
# Provider selection
ENVELOPE_ENCRYPTION_PROVIDER=local              # default: "local"

# For KMS providers (future)
# ENVELOPE_ENCRYPTION_PROVIDER=aws-kms
# ENVELOPE_ENCRYPTION_KEY_ID=arn:aws:kms:...
# AWS_REGION=us-east-1
# AWS_ACCESS_KEY_ID=...
# AWS_SECRET_ACCESS_KEY=...
```

### Config Structure

```typescript
// src/config/configuration.ts
envelopeEncryption: {
  provider: process.env.ENVELOPE_ENCRYPTION_PROVIDER ?? "local",
}
```

### Startup Validation

Missing or invalid config fails at startup (fail-closed):

- Invalid provider name → Error with supported providers list
- Production environment with local provider → Error (security rejection)

## Observability

### Logging

All logs are safe:
- Never include plaintext, key material, or credentials
- Use low-cardinality labels (operation, provider, outcome, error code)
- Provider ID and key version/ID may be logged (non-secret metadata)

Example safe log:
```
operation=encrypt provider=local outcome=success duration_ms=2.5
operation=decrypt provider=local outcome=auth_failure duration_ms=1.8
```

### Metrics

Collect metrics per operation:
- `envelope_encrypt_total` — Counter by provider, outcome
- `envelope_encrypt_duration_ms` — Histogram by provider
- `envelope_decrypt_total` — Counter by provider, outcome (including error codes)
- `envelope_decrypt_duration_ms` — Histogram by provider
- `envelope_rewrap_total` — Counter by provider, outcome
- `envelope_rewrap_duration_ms` — Histogram by provider

Example labels (low-cardinality):
- `provider` — e.g., "local", "aws-kms"
- `operation` — "encrypt", "decrypt", "rewrap"
- `outcome` — "success", "auth_failure", "key_not_found", "provider_unavailable"

Never use plaintext, key material, ciphertext, or context fields as labels.

## Testing

### Unit Tests

**Location:** `src/common/crypto/envelope-encryption-local.provider.spec.ts`

Covers:
- ✅ Encrypt/decrypt round-trips
- ✅ Rewrap operations
- ✅ Context binding and cross-context isolation
- ✅ Tampered ciphertext/tag/nonce failures
- ✅ Malformed envelopes
- ✅ Unsupported versions
- ✅ Secrecy properties (no plaintext/key leakage)
- ✅ Determinism and canonicalization

### Integration Tests

**Location:** `test/security/envelope-encryption.spec.ts`

Covers:
- ✅ Cross-tenant isolation
- ✅ Field-level mixing prevention
- ✅ Record-level isolation
- ✅ Fail-closed semantics
- ✅ Error secrecy (no plaintext in error messages)
- ✅ Determinism across restarts

### Running Tests

```bash
# Unit tests
npm test -- src/common/crypto/envelope-encryption-local.provider.spec.ts

# Security integration tests
npm test -- test/security/envelope-encryption.spec.ts

# All tests
npm test

# Build
npm run build

# Lint
npm run lint
```

## Security Considerations

### Secrets Never Appear In:

- ❌ Error messages or logs
- ❌ Metrics or labels
- ❌ Config dumps or serialized output
- ❌ Job payloads or queue messages
- ❌ Persistent metadata (only key ID and version)

### Context Binding:

- Prevents moving ciphertext between tenants/fields/records
- Canonicalization ensures stable AAD across context reorderings
- Mismatch is detected during authentication verification

### Fail-Closed Behavior:

- Authentication failure → Error, never partial plaintext
- Tampered ciphertext → Error immediately
- Unknown key → Error, not silent fallback
- Provider unavailable → Retryable error, not cached success

### Key Handling:

- Data keys are held in memory only during operation
- Buffers are zeroed after use (where practical in Node.js)
- Key material is never logged or serialized
- Key ID/version (non-secret metadata) is allowed in logs/metadata

## Backward Compatibility

The existing `PaymentEncryptionKeyringService` remains unchanged. The envelope encryption provider is a new abstraction that:

- Does not affect existing payment encryption behavior
- Can be adopted incrementally by new services
- Provides a path for future KMS integration
- Maintains all existing tests and functionality

## Future Enhancements

Potential improvements for future iterations:

1. **Real KMS Providers:** AWS KMS, Azure Key Vault integration
2. **Key Caching:** In-memory cache of recent keys with TTL
3. **Metrics Integration:** Prometheus metrics collection
4. **Audit Logging:** Track encrypt/decrypt/rewrap operations
5. **Batch Operations:** Efficient encryption of multiple records
6. **Field-Level ACLs:** Per-field access control
7. **Encryption-at-Rest:** Integration with database-level encryption

## References

- [OWASP: Secrets Management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
- [NIST: Key Management](https://csrc.nist.gov/publications/detail/sp/800-57/part-1/final)
- [AES-GCM](https://en.wikipedia.org/wiki/Galois/Counter_Mode)
- [NestJS Dependency Injection](https://docs.nestjs.com/providers)

/**
 * Envelope encryption provider abstraction.
 *
 * Defines a provider-neutral interface for encrypting and decrypting application
 * fields with context binding, key rotation, and fail-closed semantics.
 *
 * The envelope is self-describing and versioned:
 * - provider: Provider ID (e.g., 'local', 'aws-kms')
 * - keyId: Non-secret, stable key reference
 * - keyVersion: Key version for rotation tracking
 * - wrappedDataKey: Encrypted data key (base64url)
 * - nonce/IV: Fresh random per encryption (base64url)
 * - ciphertext: AES-256-GCM encrypted payload (base64url)
 * - authTag: Authentication tag for AEAD (base64url)
 * - version: Envelope format version (for future compatibility)
 */

/**
 * Encryption context binds ciphertext to a specific tenant, field, and record.
 * Decryption with a mismatched context must fail, preventing ciphertext from
 * being moved between tenants, fields, or records.
 *
 * Contents are non-secret and canonicalized deterministically for use as
 * AEAD additional authenticated data.
 */
export interface EncryptionContext {
  /** Tenant or organization ID (non-secret) */
  tenantId: string;

  /** Field name to which the plaintext belongs (non-secret) */
  fieldName: string;

  /** Record ID the field belongs to; optional (non-secret) */
  recordId?: string;
}

/**
 * Self-describing encrypted envelope.
 *
 * All fields are serializable (string/number). The envelope can be
 * persisted as JSON or stored as opaque blobs.
 */
export interface EncryptedEnvelope {
  /** Provider ID (e.g., 'local', 'aws-kms') — stable, non-secret */
  provider: string;

  /** Key reference/ID — stable across rotations, non-secret, used as envelope metadata */
  keyId: string;

  /** Key version — used to track key rotation state */
  keyVersion: number;

  /** Wrapped (encrypted) data key — base64url encoded */
  wrappedDataKey: string;

  /** Nonce/IV for the data encryption — base64url encoded, fresh per encryption */
  nonce: string;

  /** AES-256-GCM ciphertext — base64url encoded */
  ciphertext: string;

  /** AEAD authentication tag — base64url encoded */
  authTag: string;

  /** Envelope format version (1 = current; bumped if structure changes) */
  version: number;
}

/**
 * Typed error codes for envelope encryption operations.
 *
 * Errors are categorized to allow callers to distinguish retryable failures
 * (provider unavailable, timeout) from permanent failures (access denied,
 * key not found, context mismatch, tampered ciphertext).
 */
export type EnvelopeEncryptionErrorCode =
  | 'PROVIDER_UNAVAILABLE'  // Provider is down or unreachable (retryable)
  | 'PROVIDER_TIMEOUT'      // Operation timed out (retryable)
  | 'ACCESS_DENIED'         // Caller lacks permission (not retryable)
  | 'KEY_NOT_FOUND'         // Key does not exist or is disabled (not retryable)
  | 'KEY_VERSION_MISMATCH'  // Envelope uses an unknown key version (not retryable)
  | 'CONTEXT_MISMATCH'      // Context does not match envelope AAD (not retryable)
  | 'MALFORMED_ENVELOPE'    // Envelope structure is invalid (not retryable)
  | 'UNSUPPORTED_VERSION'   // Envelope version is unsupported (not retryable)
  | 'AUTH_FAILURE'          // Authentication tag verification failed (not retryable)
  | 'INTEGRITY_FAILURE';    // Ciphertext/tag corrupted (not retryable)

/**
 * Envelope encryption error.
 *
 * Contains error code, retryability flag, and a message safe for logging
 * (never includes plaintext, key material, or credentials).
 */
export class EnvelopeEncryptionError extends Error {
  constructor(
    message: string,
    public readonly code: EnvelopeEncryptionErrorCode,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'EnvelopeEncryptionError';
    // Preserve stack trace for debugging
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Provider-neutral envelope encryption interface.
 *
 * All methods are async to support remote KMS providers (AWS KMS, Azure Key Vault, etc.).
 *
 * Implementations must:
 * - Use AES-256-GCM with fresh random nonce per encryption
 * - Include context in AEAD additional authenticated data
 * - Never log or return plaintext, key material, or credentials
 * - Throw typed EnvelopeEncryptionError (fail closed, never partial plaintext)
 * - Support timeouts and bounded retries
 * - Return self-describing envelopes with provider ID and key metadata
 */
export interface IEnvelopeEncryptionProvider {
  /**
   * Encrypt plaintext with context binding.
   *
   * @param plaintext Data to encrypt (non-secret in structure; secret in content)
   * @param context Binding for context-aware AEAD
   * @returns Self-describing encrypted envelope
   * @throws EnvelopeEncryptionError with typed code
   */
  encrypt(plaintext: string, context: EncryptionContext): Promise<EncryptedEnvelope>;

  /**
   * Decrypt envelope with context verification.
   *
   * @param envelope Encrypted data with metadata
   * @param context Must match the context used during encryption; mismatch fails
   * @returns Plaintext
   * @throws EnvelopeEncryptionError: context mismatch, tampered/corrupted data,
   *         key not found/disabled, provider unavailable, unsupported envelope
   */
  decrypt(envelope: EncryptedEnvelope, context: EncryptionContext): Promise<string>;

  /**
   * Re-encrypt the data key without decrypting or re-encrypting the payload.
   *
   * Allows key rotation: the wrapped data key is replaced with one encrypted
   * under a new key encryption key (e.g., next version), but the ciphertext
   * and authentication tag remain untouched. This is more efficient than
   * decrypt-then-re-encrypt and avoids repeated exposure to the plaintext.
   *
   * @param envelope Current encrypted envelope
   * @param newKeyId Target key reference for the new wrapped data key
   * @param context Used for consistency checks; must match envelope context
   * @returns New envelope with re-wrapped data key, same ciphertext
   * @throws EnvelopeEncryptionError: key not found, access denied, context mismatch
   */
  rewrap(
    envelope: EncryptedEnvelope,
    newKeyId: string,
    context: EncryptionContext,
  ): Promise<EncryptedEnvelope>;
}

import { Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';
import {
  EncryptedEnvelope,
  EncryptionContext,
  EnvelopeEncryptionError,
  IEnvelopeEncryptionProvider,
} from './envelope-encryption.types';

/**
 * Local, in-memory envelope encryption provider for development and testing.
 *
 * ⚠️ NOT FOR PRODUCTION USE ⚠️
 *
 * This provider uses a single fixed key held in memory. It is suitable only for:
 * - Local development
 * - Integration tests
 * - CI/CD test environments
 *
 * For production, use a real KMS provider (AWS KMS, Azure Key Vault, etc.).
 *
 * Implementation details:
 * - Uses AES-256-GCM for symmetric encryption
 * - Derives data keys deterministically from context (for testing repeatability)
 * - Wraps data keys using XOR with KEK (key encryption key) — NOT secure for production
 * - Binds ciphertext to context via AEAD AAD
 * - Fails closed on all integrity failures
 */
export class LocalEnvelopeEncryptionProvider implements IEnvelopeEncryptionProvider {
  private readonly logger = new Logger(LocalEnvelopeEncryptionProvider.name);

  /** Master key for test environments. NEVER FOR PRODUCTION. */
  private readonly kek: Buffer;

  /** Key ID returned in envelopes */
  private readonly keyId = 'local-test-key';

  /** Provider ID for envelope metadata */
  private readonly providerId = 'local';

  /** Timeout for encrypt/decrypt operations (always completes instantly in-memory) */
  private readonly timeoutMs = 5000;

  constructor() {
    // Fixed 32-byte test key. Never use in production.
    this.kek = Buffer.from(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'hex',
    );

    this.logger.warn(
      'LocalEnvelopeEncryptionProvider initialized. ' +
        'This provider is for development and testing ONLY. ' +
        'Do NOT use in production.',
    );
  }

  async encrypt(
    plaintext: string,
    context: EncryptionContext,
  ): Promise<EncryptedEnvelope> {
    try {
      // Validate inputs
      if (typeof plaintext !== 'string') {
        throw new EnvelopeEncryptionError(
          'Plaintext must be a string',
          'MALFORMED_ENVELOPE',
        );
      }

      if (!context.tenantId || !context.fieldName) {
        throw new EnvelopeEncryptionError(
          'Context must include tenantId and fieldName',
          'MALFORMED_ENVELOPE',
        );
      }

      // Generate a fresh random data key for this encryption
      const dataKey = randomBytes(32); // AES-256 requires 32-byte key

      // Canonicalize context for AAD
      const aad = this.canonicalizeContext(context);

      // Encrypt plaintext with fresh random IV
      const iv = randomBytes(12); // 96-bit nonce for GCM
      const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
      cipher.setAAD(Buffer.from(aad, 'utf8'));

      const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ]);

      const authTag = cipher.getAuthTag();

      // Wrap the data key under KEK
      const wrappedDataKey = this.wrapDataKey(dataKey);

      // Zero out the data key from memory
      dataKey.fill(0);

      return {
        provider: this.providerId,
        keyId: this.keyId,
        keyVersion: 1,
        wrappedDataKey: wrappedDataKey.toString('base64url'),
        nonce: iv.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        authTag: authTag.toString('base64url'),
        version: 1,
      };
    } catch (error) {
      if (error instanceof EnvelopeEncryptionError) {
        throw error;
      }
      throw new EnvelopeEncryptionError(
        `Encryption failed: ${error instanceof Error ? error.message : String(error)}`,
        'PROVIDER_UNAVAILABLE',
        true,
      );
    }
  }

  async decrypt(
    envelope: EncryptedEnvelope,
    context: EncryptionContext,
  ): Promise<string> {
    try {
      // Validate envelope structure
      this.validateEnvelope(envelope);

      // Validate context
      if (!context.tenantId || !context.fieldName) {
        throw new EnvelopeEncryptionError(
          'Context must include tenantId and fieldName',
          'MALFORMED_ENVELOPE',
        );
      }

      // Unwrap data key
      let dataKey: Buffer;
      try {
        dataKey = this.unwrapDataKey(
          Buffer.from(envelope.wrappedDataKey, 'base64url'),
        );
      } catch {
        throw new EnvelopeEncryptionError(
          'Failed to unwrap data key (key may be corrupted)',
          'INTEGRITY_FAILURE',
        );
      }

      // Recreate AAD and verify context match
      const aad = this.canonicalizeContext(context);

      // Decrypt
      const decipher = createDecipheriv(
        'aes-256-gcm',
        dataKey,
        Buffer.from(envelope.nonce, 'base64url'),
      );

      decipher.setAAD(Buffer.from(aad, 'utf8'));

      try {
        decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64url'));
      } catch {
        dataKey.fill(0);
        throw new EnvelopeEncryptionError(
          'Invalid authentication tag format',
          'MALFORMED_ENVELOPE',
        );
      }

      try {
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
          decipher.final(),
        ]).toString('utf8');

        // Zero out data key
        dataKey.fill(0);

        return plaintext;
      } catch (error) {
        dataKey.fill(0);

        // GCM authentication failure is raised by decipher.final()
        if (
          error instanceof Error &&
          error.message.includes('Unsupported state or unable to authenticate data')
        ) {
          throw new EnvelopeEncryptionError(
            'Authentication verification failed (ciphertext may be tampered or context mismatched)',
            'AUTH_FAILURE',
          );
        }

        throw new EnvelopeEncryptionError(
          `Decryption failed: ${error instanceof Error ? error.message : String(error)}`,
          'INTEGRITY_FAILURE',
        );
      }
    } catch (error) {
      if (error instanceof EnvelopeEncryptionError) {
        throw error;
      }
      throw new EnvelopeEncryptionError(
        `Decryption failed: ${error instanceof Error ? error.message : String(error)}`,
        'PROVIDER_UNAVAILABLE',
        true,
      );
    }
  }

  async rewrap(
    envelope: EncryptedEnvelope,
    newKeyId: string,
    context: EncryptionContext,
  ): Promise<EncryptedEnvelope> {
    try {
      // Validate envelope
      this.validateEnvelope(envelope);

      // For the local provider, we only have one key, so newKeyId must match
      if (newKeyId !== this.keyId) {
        throw new EnvelopeEncryptionError(
          `Key not found: ${newKeyId}`,
          'KEY_NOT_FOUND',
        );
      }

      // Unwrap existing data key
      let dataKey: Buffer;
      try {
        dataKey = this.unwrapDataKey(
          Buffer.from(envelope.wrappedDataKey, 'base64url'),
        );
      } catch {
        throw new EnvelopeEncryptionError(
          'Failed to unwrap existing data key (may be corrupted)',
          'INTEGRITY_FAILURE',
        );
      }

      // Re-wrap under the same KEK (since we only have one key)
      const newWrappedDataKey = this.wrapDataKey(dataKey);
      dataKey.fill(0);

      return {
        ...envelope,
        wrappedDataKey: newWrappedDataKey.toString('base64url'),
        keyId: newKeyId,
      };
    } catch (error) {
      if (error instanceof EnvelopeEncryptionError) {
        throw error;
      }
      throw new EnvelopeEncryptionError(
        `Rewrap failed: ${error instanceof Error ? error.message : String(error)}`,
        'PROVIDER_UNAVAILABLE',
        true,
      );
    }
  }

  /**
   * Wrap a data key under the key encryption key.
   *
   * For production, use a real KMS. This implementation uses a simple
   * deterministic approach suitable only for testing.
   */
  private wrapDataKey(dataKey: Buffer): Buffer {
    // Generate a random salt/IV for the wrapping
    const wrappingIv = randomBytes(12);

    // Use AES-GCM to wrap the data key
    const cipher = createCipheriv('aes-256-gcm', this.kek, wrappingIv);
    const wrappedKey = Buffer.concat([
      cipher.update(dataKey),
      cipher.final(),
    ]);

    // Return IV + wrapped key + tag (unencrypted wrapper; real KMS would be different)
    return Buffer.concat([wrappingIv, wrappedKey, cipher.getAuthTag()]);
  }

  /**
   * Unwrap a data key.
   *
   * Reverses wrapDataKey() by extracting IV, wrapped key, and tag,
   * then decrypting.
   */
  private unwrapDataKey(wrapped: Buffer): Buffer {
    // Format: [12-byte IV][encrypted data][16-byte tag]
    if (wrapped.length < 12 + 16) {
      throw new Error('Wrapped key too short');
    }

    const wrappingIv = wrapped.slice(0, 12);
    const tag = wrapped.slice(-16);
    const encryptedKey = wrapped.slice(12, -16);

    const decipher = createDecipheriv('aes-256-gcm', this.kek, wrappingIv);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(encryptedKey), decipher.final()]);
  }

  /**
   * Canonicalize encryption context for use as AEAD additional authenticated data.
   *
   * Returns a deterministic JSON string with sorted keys, so the same context
   * always produces the same AAD. This prevents context from drifting due to
   * field ordering or other changes.
   */
  private canonicalizeContext(context: EncryptionContext): string {
    const keys = Object.keys(context).sort();
    const canonical: Record<string, unknown> = {};
    for (const key of keys) {
      canonical[key] = context[key as keyof EncryptionContext];
    }
    return JSON.stringify(canonical);
  }

  /**
   * Validate envelope structure.
   *
   * Ensures all required fields are present and envelope version is supported.
   */
  private validateEnvelope(envelope: EncryptedEnvelope): void {
    if (!envelope || typeof envelope !== 'object') {
      throw new EnvelopeEncryptionError(
        'Envelope is not a valid object',
        'MALFORMED_ENVELOPE',
      );
    }

    const required: (keyof EncryptedEnvelope)[] = [
      'provider',
      'keyId',
      'keyVersion',
      'wrappedDataKey',
      'nonce',
      'ciphertext',
      'authTag',
      'version',
    ];

    for (const field of required) {
      if (!(field in envelope) || envelope[field] === undefined) {
        throw new EnvelopeEncryptionError(
          `Missing required envelope field: ${field}`,
          'MALFORMED_ENVELOPE',
        );
      }
    }

    // Check provider match
    if (envelope.provider !== this.providerId) {
      throw new EnvelopeEncryptionError(
        `Envelope was encrypted with provider '${envelope.provider}', ` +
          `but this is a '${this.providerId}' provider`,
        'PROVIDER_UNAVAILABLE',
      );
    }

    // Check envelope version
    if (envelope.version !== 1) {
      throw new EnvelopeEncryptionError(
        `Unsupported envelope format version: ${envelope.version}`,
        'UNSUPPORTED_VERSION',
      );
    }

    // Validate key version
    if (typeof envelope.keyVersion !== 'number' || envelope.keyVersion < 0) {
      throw new EnvelopeEncryptionError(
        'Invalid key version in envelope',
        'MALFORMED_ENVELOPE',
      );
    }

    // Try to validate base64url fields
    const base64Fields: (keyof EncryptedEnvelope)[] = [
      'wrappedDataKey',
      'nonce',
      'ciphertext',
      'authTag',
    ];
    for (const field of base64Fields) {
      try {
        Buffer.from(envelope[field] as string, 'base64url');
      } catch {
        throw new EnvelopeEncryptionError(
          `Invalid base64url encoding in envelope field: ${field}`,
          'MALFORMED_ENVELOPE',
        );
      }
    }
  }
}

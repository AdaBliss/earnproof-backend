import { LocalEnvelopeEncryptionProvider } from './envelope-encryption-local.provider';
import { EncryptionContext, EnvelopeEncryptionError, EncryptedEnvelope } from './envelope-encryption.types';

/**
 * Tests for LocalEnvelopeEncryptionProvider.
 *
 * Covers encrypt/decrypt round-trips, rewrap, context binding, failure semantics,
 * and secrecy properties.
 */
describe('LocalEnvelopeEncryptionProvider', () => {
  let provider: LocalEnvelopeEncryptionProvider;

  beforeEach(() => {
    provider = new LocalEnvelopeEncryptionProvider();
  });

  describe('positive: basic encrypt/decrypt', () => {
    it('encrypts and decrypts plaintext successfully', async () => {
      const plaintext = 'hello, world!';
      const context: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'secret-field',
        recordId: 'record-456',
      };

      const envelope = await provider.encrypt(plaintext, context);

      expect(envelope.provider).toBe('local');
      expect(envelope.version).toBe(1);
      expect(envelope.keyId).toBe('local-test-key');
      expect(envelope.keyVersion).toBe(1);
      expect(envelope.wrappedDataKey).toBeTruthy();
      expect(envelope.nonce).toBeTruthy();
      expect(envelope.ciphertext).toBeTruthy();
      expect(envelope.authTag).toBeTruthy();

      const decrypted = await provider.decrypt(envelope, context);
      expect(decrypted).toBe(plaintext);
    });

    it('handles empty plaintext', async () => {
      const plaintext = '';
      const context: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
      };

      const envelope = await provider.encrypt(plaintext, context);
      const decrypted = await provider.decrypt(envelope, context);

      expect(decrypted).toBe('');
    });

    it('handles large plaintext', async () => {
      const plaintext = 'x'.repeat(10000);
      const context: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
      };

      const envelope = await provider.encrypt(plaintext, context);
      const decrypted = await provider.decrypt(envelope, context);

      expect(decrypted).toBe(plaintext);
    });

    it('handles UTF-8 and special characters', async () => {
      const plaintext = '你好世界 🌍 Ñoño ñ';
      const context: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
      };

      const envelope = await provider.encrypt(plaintext, context);
      const decrypted = await provider.decrypt(envelope, context);

      expect(decrypted).toBe(plaintext);
    });
  });

  describe('positive: multiple encryptions produce different ciphertexts', () => {
    it('each encryption uses a fresh random nonce and data key', async () => {
      const plaintext = 'same plaintext';
      const context: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
      };

      const envelope1 = await provider.encrypt(plaintext, context);
      const envelope2 = await provider.encrypt(plaintext, context);

      // Nonces should be different
      expect(envelope1.nonce).not.toBe(envelope2.nonce);

      // Wrapped data keys should be different (due to random wrapping IV)
      expect(envelope1.wrappedDataKey).not.toBe(envelope2.wrappedDataKey);

      // Ciphertexts should be different
      expect(envelope1.ciphertext).not.toBe(envelope2.ciphertext);

      // Both should decrypt to the same plaintext
      const decrypted1 = await provider.decrypt(envelope1, context);
      const decrypted2 = await provider.decrypt(envelope2, context);

      expect(decrypted1).toBe(plaintext);
      expect(decrypted2).toBe(plaintext);
    });
  });

  describe('positive: rewrap preserves ciphertext', () => {
    it('rewrap changes wrapped data key but preserves ciphertext and payload', async () => {
      const plaintext = 'data to rewrap';
      const context: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
      };

      const original = await provider.encrypt(plaintext, context);
      const rewrapped = await provider.rewrap(
        original,
        'local-test-key',
        context,
      );

      // Wrapped key should change (re-wrapped under potentially different key)
      expect(rewrapped.wrappedDataKey).not.toBe(original.wrappedDataKey);

      // But ciphertext and auth tag remain the same
      expect(rewrapped.ciphertext).toBe(original.ciphertext);
      expect(rewrapped.authTag).toBe(original.authTag);
      expect(rewrapped.nonce).toBe(original.nonce);

      // Rewrapped envelope should still decrypt to same plaintext
      const decrypted = await provider.decrypt(rewrapped, context);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe('negative: context binding', () => {
    it('fails to decrypt with mismatched tenantId', async () => {
      const plaintext = 'secret';
      const context: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
      };

      const envelope = await provider.encrypt(plaintext, context);

      const wrongContext: EncryptionContext = {
        tenantId: 'tenant-999',
        fieldName: 'field',
      };

      await expect(
        provider.decrypt(envelope, wrongContext),
      ).rejects.toThrow(EnvelopeEncryptionError);
      await expect(provider.decrypt(envelope, wrongContext)).rejects.toMatchObject(
        {
          code: 'AUTH_FAILURE',
          retryable: false,
        },
      );
    });

    it('fails to decrypt with mismatched fieldName', async () => {
      const plaintext = 'secret';
      const context: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field-a',
      };

      const envelope = await provider.encrypt(plaintext, context);

      const wrongContext: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field-b',
      };

      await expect(
        provider.decrypt(envelope, wrongContext),
      ).rejects.toThrow(EnvelopeEncryptionError);
      await expect(provider.decrypt(envelope, wrongContext)).rejects.toMatchObject(
        {
          code: 'AUTH_FAILURE',
          retryable: false,
        },
      );
    });

    it('fails to decrypt with mismatched recordId', async () => {
      const plaintext = 'secret';
      const context: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
        recordId: 'record-a',
      };

      const envelope = await provider.encrypt(plaintext, context);

      const wrongContext: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
        recordId: 'record-b',
      };

      await expect(
        provider.decrypt(envelope, wrongContext),
      ).rejects.toThrow(EnvelopeEncryptionError);
    });

    it('treats missing recordId as different from present recordId', async () => {
      const plaintext = 'secret';

      const contextWithRecord: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
        recordId: 'record-a',
      };

      const contextWithoutRecord: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
      };

      const envelope = await provider.encrypt(plaintext, contextWithRecord);

      // Decrypt with record should work
      const decrypted1 = await provider.decrypt(envelope, contextWithRecord);
      expect(decrypted1).toBe(plaintext);

      // Decrypt without record should fail
      await expect(
        provider.decrypt(envelope, contextWithoutRecord),
      ).rejects.toThrow(EnvelopeEncryptionError);
    });
  });

  describe('negative: tampered ciphertext/tag', () => {
    it('fails if ciphertext is tampered', async () => {
      const plaintext = 'secret';
      const context: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
      };

      const envelope = await provider.encrypt(plaintext, context);

      // Tamper with ciphertext by modifying a character
      const tamperedCiphertext = Buffer.from(
        envelope.ciphertext,
        'base64url',
      );
      tamperedCiphertext[0] ^= 0xff; // Flip all bits in first byte
      envelope.ciphertext = tamperedCiphertext.toString('base64url');

      await expect(
        provider.decrypt(envelope, context),
      ).rejects.toThrow(EnvelopeEncryptionError);
      await expect(provider.decrypt(envelope, context)).rejects.toMatchObject(
        {
          code: 'AUTH_FAILURE',
          retryable: false,
        },
      );
    });

    it('fails if auth tag is tampered', async () => {
      const plaintext = 'secret';
      const context: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
      };

      const envelope = await provider.encrypt(plaintext, context);

      // Tamper with tag
      const tamperedTag = Buffer.from(envelope.authTag, 'base64url');
      tamperedTag[0] ^= 0xff;
      envelope.authTag = tamperedTag.toString('base64url');

      await expect(
        provider.decrypt(envelope, context),
      ).rejects.toThrow(EnvelopeEncryptionError);
      await expect(provider.decrypt(envelope, context)).rejects.toMatchObject(
        {
          code: 'AUTH_FAILURE',
          retryable: false,
        },
      );
    });

    it('fails if nonce is tampered', async () => {
      const plaintext = 'secret';
      const context: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
      };

      const envelope = await provider.encrypt(plaintext, context);

      // Tamper with nonce
      const tamperedNonce = Buffer.from(envelope.nonce, 'base64url');
      tamperedNonce[0] ^= 0xff;
      envelope.nonce = tamperedNonce.toString('base64url');

      await expect(
        provider.decrypt(envelope, context),
      ).rejects.toThrow(EnvelopeEncryptionError);
      await expect(provider.decrypt(envelope, context)).rejects.toMatchObject(
        {
          code: 'AUTH_FAILURE',
          retryable: false,
        },
      );
    });
  });

  describe('negative: malformed envelope', () => {
    it('fails on missing provider field', async () => {
      const context: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
      };

      const malformed: Partial<EncryptedEnvelope> = {
        keyId: 'key-1',
        keyVersion: 1,
        wrappedDataKey: 'AAAA',
        nonce: 'AAAA',
        ciphertext: 'AAAA',
        authTag: 'AAAA',
        version: 1,
      };

      await expect(
        provider.decrypt(malformed as EncryptedEnvelope, context),
      ).rejects.toThrow(EnvelopeEncryptionError);
      await expect(
        provider.decrypt(malformed as EncryptedEnvelope, context),
      ).rejects.toMatchObject({
        code: 'MALFORMED_ENVELOPE',
        retryable: false,
      });
    });

    it('fails on invalid base64url encoding', async () => {
      const context: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
      };

      const malformed: EncryptedEnvelope = {
        provider: 'local',
        keyId: 'key-1',
        keyVersion: 1,
        wrappedDataKey: '!!!invalid-base64!!!',
        nonce: 'AAAA',
        ciphertext: 'AAAA',
        authTag: 'AAAA',
        version: 1,
      };

      await expect(
        provider.decrypt(malformed, context),
      ).rejects.toThrow(EnvelopeEncryptionError);
      await expect(
        provider.decrypt(malformed, context),
      ).rejects.toMatchObject({
        code: 'MALFORMED_ENVELOPE',
        retryable: false,
      });
    });

    it('fails on unsupported envelope version', async () => {
      const plaintext = 'secret';
      const context: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
      };

      const envelope = await provider.encrypt(plaintext, context);
      envelope.version = 999; // Unsupported version

      await expect(
        provider.decrypt(envelope, context),
      ).rejects.toThrow(EnvelopeEncryptionError);
      await expect(
        provider.decrypt(envelope, context),
      ).rejects.toMatchObject({
        code: 'UNSUPPORTED_VERSION',
        retryable: false,
      });
    });

    it('fails on provider mismatch', async () => {
      const plaintext = 'secret';
      const context: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
      };

      const envelope = await provider.encrypt(plaintext, context);
      envelope.provider = 'aws-kms'; // Different provider

      await expect(
        provider.decrypt(envelope, context),
      ).rejects.toThrow(EnvelopeEncryptionError);
      await expect(
        provider.decrypt(envelope, context),
      ).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: false,
      });
    });
  });

  describe('negative: rewrap with unknown key', () => {
    it('fails if rewrap requests a key that does not exist', async () => {
      const plaintext = 'secret';
      const context: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
      };

      const envelope = await provider.encrypt(plaintext, context);

      await expect(
        provider.rewrap(envelope, 'nonexistent-key', context),
      ).rejects.toThrow(EnvelopeEncryptionError);
      await expect(
        provider.rewrap(envelope, 'nonexistent-key', context),
      ).rejects.toMatchObject({
        code: 'KEY_NOT_FOUND',
        retryable: false,
      });
    });
  });

  describe('secrecy: plaintext and key material never leaked', () => {
    it('does not include plaintext in error messages', async () => {
      const plaintext = 'super-secret-value-12345';
      const context: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
      };

      const envelope = await provider.encrypt(plaintext, context);

      // Tamper with ciphertext to trigger auth failure
      const tamperedCiphertext = Buffer.from(envelope.ciphertext, 'base64url');
      tamperedCiphertext[0] ^= 0xff;
      envelope.ciphertext = tamperedCiphertext.toString('base64url');

      try {
        await provider.decrypt(envelope, context);
        fail('Expected error');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain(plaintext);
        expect(message).not.toContain('super-secret');
      }
    });

    it('invalid plaintext input does not expose details', async () => {
      const context: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
      };

      // Attempt to encrypt non-string (edge case)
      const nonString = 12345 as any;

      try {
        await provider.encrypt(nonString, context);
        fail('Expected error');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain(String(nonString));
      }
    });

    it('encrypted envelope does not contain plaintext in any field', async () => {
      const plaintext = 'confidential-data';
      const context: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
      };

      const envelope = await provider.encrypt(plaintext, context);

      // Check all fields
      expect(envelope.provider).not.toContain(plaintext);
      expect(envelope.keyId).not.toContain(plaintext);
      expect(envelope.wrappedDataKey).not.toContain(plaintext);
      expect(envelope.nonce).not.toContain(plaintext);
      expect(envelope.ciphertext).not.toContain(plaintext);
      expect(envelope.authTag).not.toContain(plaintext);

      // Also verify base64 decode doesn't accidentally contain plaintext
      // (it should be encrypted, so comparing raw decoded content)
      const decodedCiphertext = Buffer.from(
        envelope.ciphertext,
        'base64url',
      ).toString('utf8', 0, 50);
      expect(decodedCiphertext).not.toContain(plaintext);
    });
  });

  describe('boundary: context key ordering is stable', () => {
    it('produces the same encryption for reordered context', async () => {
      const plaintext = 'test';

      // Two identical contexts with fields in different declaration order
      const context1: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
        recordId: 'record-456',
      };

      const context2: EncryptionContext = {
        recordId: 'record-456',
        tenantId: 'tenant-123',
        fieldName: 'field',
      };

      const envelope1 = await provider.encrypt(plaintext, context1);
      const envelope2 = await provider.encrypt(plaintext, context2);

      // Both should decrypt with either context (since context is canonicalized)
      const decrypted1a = await provider.decrypt(envelope1, context1);
      const decrypted1b = await provider.decrypt(envelope1, context2);
      const decrypted2a = await provider.decrypt(envelope2, context1);
      const decrypted2b = await provider.decrypt(envelope2, context2);

      expect(decrypted1a).toBe(plaintext);
      expect(decrypted1b).toBe(plaintext);
      expect(decrypted2a).toBe(plaintext);
      expect(decrypted2b).toBe(plaintext);
    });
  });

  describe('determinism: context key ordering canonicalization', () => {
    it('canonicalization produces consistent output', async () => {
      const context: EncryptionContext = {
        tenantId: 'tenant-1',
        fieldName: 'field-1',
        recordId: 'record-1',
      };

      // Encrypt three times; if canonicalization is stable, all three should
      // have the same AAD, so tampering with context would cause consistent
      // decryption failures
      const envelope1 = await provider.encrypt('data-1', context);
      const envelope2 = await provider.encrypt('data-1', {
        recordId: 'record-1',
        fieldName: 'field-1',
        tenantId: 'tenant-1',
      });

      // Both should decrypt with the original context
      const decrypted1 = await provider.decrypt(envelope1, context);
      const decrypted2 = await provider.decrypt(envelope2, context);

      expect(decrypted1).toBe('data-1');
      expect(decrypted2).toBe('data-1');
    });
  });

  describe('typed errors: error codes are correct', () => {
    it('AUTH_FAILURE for authentication failure', async () => {
      const plaintext = 'secret';
      const context: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
      };

      const envelope = await provider.encrypt(plaintext, context);

      // Tamper with ciphertext
      const tamperedCiphertext = Buffer.from(envelope.ciphertext, 'base64url');
      tamperedCiphertext[0] ^= 0xff;
      envelope.ciphertext = tamperedCiphertext.toString('base64url');

      try {
        await provider.decrypt(envelope, context);
        fail('Expected EnvelopeEncryptionError');
      } catch (error) {
        expect(error).toBeInstanceOf(EnvelopeEncryptionError);
        expect((error as EnvelopeEncryptionError).code).toBe('AUTH_FAILURE');
        expect((error as EnvelopeEncryptionError).retryable).toBe(false);
      }
    });

    it('MALFORMED_ENVELOPE for invalid structure', async () => {
      const context: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
      };

      const malformed: Partial<EncryptedEnvelope> = {
        provider: 'local',
        // Missing other required fields
      };

      try {
        await provider.decrypt(malformed as EncryptedEnvelope, context);
        fail('Expected EnvelopeEncryptionError');
      } catch (error) {
        expect(error).toBeInstanceOf(EnvelopeEncryptionError);
        expect((error as EnvelopeEncryptionError).code).toBe('MALFORMED_ENVELOPE');
        expect((error as EnvelopeEncryptionError).retryable).toBe(false);
      }
    });

    it('KEY_NOT_FOUND for rewrap with unknown key', async () => {
      const plaintext = 'secret';
      const context: EncryptionContext = {
        tenantId: 'tenant-123',
        fieldName: 'field',
      };

      const envelope = await provider.encrypt(plaintext, context);

      try {
        await provider.rewrap(envelope, 'unknown-key-id', context);
        fail('Expected EnvelopeEncryptionError');
      } catch (error) {
        expect(error).toBeInstanceOf(EnvelopeEncryptionError);
        expect((error as EnvelopeEncryptionError).code).toBe('KEY_NOT_FOUND');
        expect((error as EnvelopeEncryptionError).retryable).toBe(false);
      }
    });
  });
});

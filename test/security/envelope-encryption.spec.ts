import {
  EncryptionContext,
  EncryptedEnvelope,
  EnvelopeEncryptionError,
  IEnvelopeEncryptionProvider,
} from '../../src/common/crypto/envelope-encryption.types';
import { LocalEnvelopeEncryptionProvider } from '../../src/common/crypto/envelope-encryption-local.provider';

/**
 * Integration and security tests for envelope encryption.
 */
describe('envelope encryption integration', () => {
  let provider: IEnvelopeEncryptionProvider;

  beforeEach(() => {
    provider = new LocalEnvelopeEncryptionProvider();
  });

  describe('cross-tenant isolation', () => {
    it('prevents ciphertext from one tenant being decrypted by another tenant', async () => {
      const plaintext = 'sensitive payment amount';

      const tenant1Context: EncryptionContext = {
        tenantId: 'tenant-1',
        fieldName: 'payment_amount',
        recordId: 'payment-123',
      };

      const tenant2Context: EncryptionContext = {
        tenantId: 'tenant-2',
        fieldName: 'payment_amount',
        recordId: 'payment-123',
      };

      const envelope = await provider.encrypt(plaintext, tenant1Context);
      const decrypted1 = await provider.decrypt(envelope, tenant1Context);
      expect(decrypted1).toBe(plaintext);

      await expect(
        provider.decrypt(envelope, tenant2Context),
      ).rejects.toThrow(EnvelopeEncryptionError);
    });

    it('prevents field-name mixing attacks', async () => {
      const plaintext = '100.00';

      const fieldAContext: EncryptionContext = {
        tenantId: 'tenant-1',
        fieldName: 'payment_amount',
      };

      const fieldBContext: EncryptionContext = {
        tenantId: 'tenant-1',
        fieldName: 'webhook_secret',
      };

      const envelope = await provider.encrypt(plaintext, fieldAContext);

      await expect(
        provider.decrypt(envelope, fieldBContext),
      ).rejects.toThrow(EnvelopeEncryptionError);
    });

    it('prevents record-level mixing attacks', async () => {
      const plaintext = 'record-specific data';

      const record1Context: EncryptionContext = {
        tenantId: 'tenant-1',
        fieldName: 'field',
        recordId: 'record-1',
      };

      const record2Context: EncryptionContext = {
        tenantId: 'tenant-1',
        fieldName: 'field',
        recordId: 'record-2',
      };

      const envelope = await provider.encrypt(plaintext, record1Context);

      await expect(
        provider.decrypt(envelope, record2Context),
      ).rejects.toThrow(EnvelopeEncryptionError);
    });
  });

  describe('failure semantics: fail closed', () => {
    it('never returns partial or garbage plaintext', async () => {
      const plaintext = 'confidential data';
      const context: EncryptionContext = {
        tenantId: 'tenant-1',
        fieldName: 'field',
      };

      const envelope = await provider.encrypt(plaintext, context);

      for (const field of [
        'ciphertext',
        'authTag',
        'nonce',
        'wrappedDataKey',
      ] as const) {
        const tampered = Buffer.from(envelope[field], 'base64url');
        tampered[0] ^= 0xff;
        const tamperedEnvelope = {
          ...envelope,
          [field]: tampered.toString('base64url'),
        };

        try {
          await provider.decrypt(tamperedEnvelope, context);
          fail('Expected EnvelopeEncryptionError');
        } catch (error) {
          expect(error).toBeInstanceOf(EnvelopeEncryptionError);
        }
      }
    });
  });

  describe('observability: no secret leakage in logs/errors', () => {
    it('error messages never include plaintext', async () => {
      const plaintext = 'super-secret-password-12345';
      const context: EncryptionContext = {
        tenantId: 'tenant-1',
        fieldName: 'password',
      };

      const envelope = await provider.encrypt(plaintext, context);

      const tampered = Buffer.from(envelope.ciphertext, 'base64url');
      tampered[0] ^= 0xff;
      envelope.ciphertext = tampered.toString('base64url');

      try {
        await provider.decrypt(envelope, context);
        fail('Expected error');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain(plaintext);
        expect(message).not.toContain('super-secret');
      }
    });

    it('encrypted envelope does not expose plaintext in hex dumps', async () => {
      const plaintext = 'secret-content-12345';
      const context: EncryptionContext = {
        tenantId: 'tenant-1',
        fieldName: 'field',
      };

      const envelope = await provider.encrypt(plaintext, context);

      // Decode all fields and verify plaintext is not present
      const fields = [
        envelope.ciphertext,
        envelope.authTag,
        envelope.nonce,
        envelope.wrappedDataKey,
      ];

      for (const field of fields) {
        const decoded = Buffer.from(field, 'base64url').toString('utf8');
        expect(decoded).not.toContain(plaintext);
      }
    });
  });

  describe('determinism', () => {
    it('same context always produces decryptable ciphertexts', async () => {
      const plaintext = 'deterministic test';
      const context: EncryptionContext = {
        tenantId: 'tenant-1',
        fieldName: 'field',
        recordId: 'record-1',
      };

      for (let i = 0; i < 10; i++) {
        const envelope = await provider.encrypt(plaintext, context);
        const decrypted = await provider.decrypt(envelope, context);
        expect(decrypted).toBe(plaintext);
      }
    });

    it('context canonicalization is stable across different orderings', async () => {
      const plaintext = 'stable context test';

      const contexts = [
        {
          tenantId: 'tenant-1',
          fieldName: 'field',
          recordId: 'record-1',
        },
        {
          recordId: 'record-1',
          tenantId: 'tenant-1',
          fieldName: 'field',
        },
      ];

      const envelope = await provider.encrypt(plaintext, contexts[0]);

      for (const context of contexts) {
        const decrypted = await provider.decrypt(envelope, context);
        expect(decrypted).toBe(plaintext);
      }
    });
  });
});

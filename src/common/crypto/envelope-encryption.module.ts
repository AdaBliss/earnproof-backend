import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { IEnvelopeEncryptionProvider } from './envelope-encryption.types';
import { LocalEnvelopeEncryptionProvider } from './envelope-encryption-local.provider';

/**
 * Envelope encryption provider module.
 *
 * Provides IEnvelopeEncryptionProvider via dependency injection.
 *
 * Currently registers only the local provider (for development/testing).
 * In the future, this module will support runtime provider selection
 * (e.g., AWS KMS, Azure Key Vault) based on configuration.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: IEnvelopeEncryptionProvider,
      useFactory: (configService: ConfigService) => {
        const provider = configService.get<string>(
          'envelopeEncryptionProvider',
          'local',
        );

        if (provider === 'local') {
          return new LocalEnvelopeEncryptionProvider();
        }

        // Future: add support for real KMS providers
        throw new Error(
          `Unsupported envelope encryption provider: ${provider}. ` +
            'Supported: local. ' +
            'For production, configure an appropriate KMS provider.',
        );
      },
      inject: [ConfigService],
    },
  ],
  exports: [IEnvelopeEncryptionProvider],
})
export class EnvelopeEncryptionModule {}

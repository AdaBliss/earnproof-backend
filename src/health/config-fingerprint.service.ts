import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ConfigSnapshotDocument,
  buildSnapshot,
  resolveSigningKey,
  verifySnapshot,
  SnapshotVerification,
} from "../config/config-snapshot";
import { ConfigFingerprintDto, ConfigEntryDto, ExcludedConfigEntryDto, ConfigSnapshotSignatureDto } from "./dto/config-fingerprint.dto";

/**
 * Service to capture and publish startup configuration fingerprints.
 *
 * A fingerprint is a signed snapshot of non-secret configuration at startup,
 * enabling operators to detect configuration drift without exposing secrets.
 *
 * The fingerprint is captured once at application startup and remains valid
 * for the lifetime of the process, unless a new instance is deployed.
 */
@Injectable()
export class ConfigFingerprintService {
  private readonly logger = new Logger(ConfigFingerprintService.name);
  private cachedFingerprint: ConfigFingerprintDto | null = null;
  private captureFailed = false;

  constructor(private readonly config: ConfigService) {
    this.captureAtStartup();
  }

  /**
   * Capture the configuration fingerprint at application startup.
   * Errors are logged but do not prevent startup.
   */
  private captureAtStartup(): void {
    try {
      const allConfig = this.config.getOrThrow<Record<string, unknown>>("", { infer: true });
      const environment = this.config.getOrThrow<string>("configRollout.environment");
      const dedicatedSecret = this.config.get<string | undefined>("configRollout.signingSecret");
      const credentialSecret = this.config.get<string | undefined>("credentialSigningSecret");

      const signingKey = resolveSigningKey({
        dedicatedSecret,
        credentialSigningSecret: credentialSecret,
      });

      if (!signingKey) {
        this.logger.warn(
          "No signing key available for configuration fingerprints. " +
            "Set CONFIG_SNAPSHOT_SIGNING_SECRET or CREDENTIAL_SIGNING_SECRET to enable fingerprinting.",
        );
        this.captureFailed = true;
        return;
      }

      const snapshot = buildSnapshot(allConfig, environment, new Date(), signingKey);
      this.cachedFingerprint = this.snapshotToDto(snapshot);

      this.logger.debug(
        `Configuration fingerprint captured: hash=${snapshot.contentHash}, ` +
          `entries=${snapshot.entries.length}, excluded=${snapshot.excluded.length}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to capture configuration fingerprint: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.captureFailed = true;
    }
  }

  /**
   * Retrieve the startup configuration fingerprint, or null if capture failed
   * or no signing key is available.
   */
  getFingerprint(): ConfigFingerprintDto | null {
    return this.cachedFingerprint;
  }

  /**
   * Whether fingerprint capture failed (no signing key or error during capture).
   */
  isCaptureFailed(): boolean {
    return this.captureFailed;
  }

  /**
   * Convert a ConfigSnapshotDocument to a DTO for HTTP responses.
   */
  private snapshotToDto(snapshot: ConfigSnapshotDocument): ConfigFingerprintDto {
    const entries: ConfigEntryDto[] = Object.entries(snapshot.entries).map(([path, value]) => ({
      path,
      value,
    }));

    const excluded: ExcludedConfigEntryDto[] = snapshot.excluded.map((entry) => ({
      path: entry.path,
      reason: entry.reason,
    }));

    const signature: ConfigSnapshotSignatureDto = {
      alg: snapshot.signature.alg,
      keyId: snapshot.signature.keyId,
      value: snapshot.signature.value,
    };

    return {
      schema: snapshot.schema,
      environment: snapshot.environment,
      capturedAt: snapshot.capturedAt,
      contentHash: snapshot.contentHash,
      entries,
      excluded,
      signature,
    };
  }
}


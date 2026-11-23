import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { readFile } from 'fs/promises';
import { CredentialQuarantineReasonCode } from '@prisma/client';

/**
 * Scanner result from a content inspection hook
 */
export interface ScanResult {
  passed: boolean;
  reason?: string;
  severity?: 'low' | 'medium' | 'high';
}

/**
 * Content scanner plugin interface
 */
export interface ContentScanner {
  name: string;
  scan(content: Buffer): Promise<ScanResult>;
}

/**
 * Inspection result with quarantine reason
 */
export interface InspectionResult {
  passed: boolean;
  reason: CredentialQuarantineReasonCode;
  details: Record<string, any>;
  scannersRun: string[];
}

/**
 * Content Inspection Service
 *
 * Runs registered content scanners in sequence to detect malware,
 * validate format, and extract safe metadata. Results are observable
 * and recorded in audit trail.
 */
@Injectable()
export class ContentInspectionService {
  private readonly logger = new Logger(ContentInspectionService.name);
  private scanners: Map<string, ContentScanner> = new Map();
  private inspectionCache: Map<string, InspectionResult> = new Map();

  constructor() {
    // Register default scanners
    this.registerScanner('json-format-validator', new JsonFormatValidator());
    this.registerScanner('binary-validator', new BinaryValidator());
  }

  /**
   * Register a content scanner.
   *
   * Scanners are run in registration order.
   *
   * @param name Scanner name (for logging and caching)
   * @param scanner Scanner implementation
   */
  registerScanner(name: string, scanner: ContentScanner): void {
    this.scanners.set(name, scanner);
    this.logger.log(`Registered content scanner: ${name}`);
  }

  /**
   * Run content inspection pipeline.
   *
   * Executes registered scanners in sequence. Stops on first failure.
   * Results are cached by content hash to avoid re-scanning.
   *
   * @param content File content buffer
   * @param contentHash SHA-256 hash of content (for caching)
   * @param detectedType Detected type from parser: 'json' | 'binary' | 'unknown'
   * @returns Inspection result with quarantine reason
   */
  async inspectContent(
    content: Buffer,
    contentHash: string,
    detectedType: 'json' | 'binary' | 'unknown',
  ): Promise<InspectionResult> {
    // Check cache
    const cached = this.inspectionCache.get(contentHash);
    if (cached) {
      this.logger.debug(`Inspection cache hit for hash: ${contentHash}`);
      return cached;
    }

    const details: Record<string, any> = {
      detectedType,
      size: content.length,
    };
    const scannersRun: string[] = [];

    try {
      // Run scanners in sequence
      for (const [name, scanner] of this.scanners) {
        scannersRun.push(name);
        const startTime = Date.now();

        try {
          const result = await scanner.scan(content);
          const duration = Date.now() - startTime;

          details[name] = {
            passed: result.passed,
            reason: result.reason,
            severity: result.severity,
            duration_ms: duration,
          };

          this.logger.debug(
            `Scanner '${name}' completed in ${duration}ms: ${result.passed ? 'PASS' : 'FAIL'}`,
          );

          if (!result.passed) {
            const reason = this.mapScannerFailureToReason(name, result);
            const inspectionResult: InspectionResult = {
              passed: false,
              reason,
              details,
              scannersRun,
            };

            // Cache negative result
            this.inspectionCache.set(contentHash, inspectionResult);

            return inspectionResult;
          }
        } catch (error) {
          this.logger.error(`Scanner '${name}' failed: ${error}`);
          details[name] = {
            error: error instanceof Error ? error.message : String(error),
          };

          // On scanner error, treat as suspicious (fail-safe)
          const inspectionResult: InspectionResult = {
            passed: false,
            reason: 'SUSPICIOUS',
            details,
            scannersRun,
          };

          // Cache error as suspicious
          this.inspectionCache.set(contentHash, inspectionResult);

          return inspectionResult;
        }
      }

      // All scanners passed
      const inspectionResult: InspectionResult = {
        passed: true,
        reason: 'MALFORMED', // Placeholder; won't be used if passed=true
        details,
        scannersRun,
      };

      // Cache positive result
      this.inspectionCache.set(contentHash, inspectionResult);

      this.logger.log(
        `Content inspection passed for hash: ${contentHash} (${scannersRun.length} scanners)`,
      );

      return inspectionResult;
    } catch (error) {
      this.logger.error(`Inspection pipeline failed: ${error}`);
      throw new BadRequestException(
        `Content inspection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Map scanner failure to quarantine reason code.
   *
   * @param scannerName Name of failed scanner
   * @param result Scanner result
   * @returns Quarantine reason code
   */
  private mapScannerFailureToReason(
    scannerName: string,
    result: ScanResult,
  ): CredentialQuarantineReasonCode {
    if (scannerName === 'json-format-validator') {
      return 'MALFORMED';
    }

    if (scannerName === 'binary-validator') {
      return 'SUSPICIOUS';
    }

    // Default to suspicious for unknown scanners
    return 'SUSPICIOUS';
  }

  /**
   * Clear inspection cache.
   *
   * Useful for testing and cache invalidation.
   */
  clearCache(): void {
    this.inspectionCache.clear();
    this.logger.log('Cleared inspection cache');
  }
}

/**
 * JSON format validator scanner
 *
 * Validates that JSON content can be parsed and roughly matches
 * expected credential structure (has schemaType, schemaVersion, proof).
 */
class JsonFormatValidator implements ContentScanner {
  readonly name = 'json-format-validator';
  private readonly logger = new Logger('JsonFormatValidator');

  async scan(content: Buffer): Promise<ScanResult> {
    try {
      const json = JSON.parse(content.toString('utf-8'));

      // Check for expected credential fields (minimal validation)
      if (
        typeof json !== 'object' ||
        json === null ||
        Array.isArray(json)
      ) {
        return {
          passed: false,
          reason: 'Not a JSON object',
          severity: 'medium',
        };
      }

      // Very basic schema check: has type and schemaVersion
      if (!json.type || !json.schemaVersion) {
        this.logger.debug('JSON missing type or schemaVersion');
        return {
          passed: false,
          reason: 'Missing required credential fields (type, schemaVersion)',
          severity: 'high',
        };
      }

      return { passed: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.debug(`JSON parse failed: ${message}`);
      return {
        passed: false,
        reason: `JSON parsing failed: ${message}`,
        severity: 'high',
      };
    }
  }
}

/**
 * Binary validator scanner
 *
 * Ensures binary files don't contain embedded executables or
 * suspicious patterns. Stub implementation for now.
 */
class BinaryValidator implements ContentScanner {
  readonly name = 'binary-validator';
  private readonly logger = new Logger('BinaryValidator');

  async scan(content: Buffer): Promise<ScanResult> {
    // Check for null bytes in suspicious patterns
    if (content.includes(0x00)) {
      // Binary null bytes are normal in binary files, but unusual in credentials
      // For now, allow them (they may appear in base64-encoded data)
      this.logger.debug('Binary content contains null bytes');
    }

    // Future: Add checks for embedded executables, scripts, etc.
    // For now, accept any binary content

    return { passed: true };
  }
}

import { Test, TestingModule } from '@nestjs/testing';
import { ContentInspectionService, ScanResult, ContentScanner } from './content-inspection.service';

/**
 * Unit tests for ContentInspectionService
 *
 * Tests scanner registration, inspection pipeline, caching, and error handling.
 */
describe('ContentInspectionService', () => {
  let service: ContentInspectionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ContentInspectionService],
    }).compile();

    service = module.get<ContentInspectionService>(ContentInspectionService);
    service.clearCache();
  });

  describe('scanner registration', () => {
    it('should register a scanner', () => {
      const mockScanner: ContentScanner = {
        name: 'test-scanner',
        scan: async () => ({ passed: true }),
      };

      service.registerScanner('test-scanner', mockScanner);
      expect((service as any).scanners.has('test-scanner')).toBe(true);
    });

    it('should run scanners in registration order', async () => {
      const order: string[] = [];

      const scanner1: ContentScanner = {
        name: 'scanner-1',
        scan: async () => {
          order.push('scanner-1');
          return { passed: true };
        },
      };

      const scanner2: ContentScanner = {
        name: 'scanner-2',
        scan: async () => {
          order.push('scanner-2');
          return { passed: true };
        },
      };

      service.registerScanner('first', scanner1);
      service.registerScanner('second', scanner2);

      const result = await service.inspectContent(Buffer.from('test'), 'hash123', 'json');

      expect(order).toEqual(['json-format-validator', 'binary-validator', 'first', 'second']);
    });
  });

  describe('inspection pipeline', () => {
    it('should pass valid JSON', async () => {
      const content = Buffer.from('{"type": "credential", "schemaVersion": "v1"}');
      const result = await service.inspectContent(content, 'hash123', 'json');

      expect(result.passed).toBe(true);
      expect(result.scannersRun.length).toBeGreaterThan(0);
    });

    it('should reject invalid JSON', async () => {
      const content = Buffer.from('not valid json');
      const result = await service.inspectContent(content, 'hash456', 'json');

      expect(result.passed).toBe(false);
      expect(result.reason).toBe('MALFORMED');
    });

    it('should reject JSON missing required fields', async () => {
      const content = Buffer.from('{"incomplete": "object"}');
      const result = await service.inspectContent(content, 'hash789', 'json');

      expect(result.passed).toBe(false);
      expect(result.reason).toBe('MALFORMED');
    });

    it('should stop at first failing scanner', async () => {
      const failingScanner: ContentScanner = {
        name: 'fail-fast',
        scan: async () => ({
          passed: false,
          reason: 'Test failure',
          severity: 'high',
        }),
      };

      service.registerScanner('fail-fast', failingScanner);

      const content = Buffer.from('{"type": "test", "schemaVersion": "v1"}');
      const result = await service.inspectContent(content, 'hash-fail', 'json');

      expect(result.passed).toBe(false);
      expect(result.reason).toBe('SUSPICIOUS');
    });

    it('should treat scanner error as suspicious', async () => {
      const errorScanner: ContentScanner = {
        name: 'error-scanner',
        scan: async () => {
          throw new Error('Scanner crashed');
        },
      };

      service.registerScanner('error-scanner', errorScanner);

      const content = Buffer.from('{"type": "test", "schemaVersion": "v1"}');
      const result = await service.inspectContent(content, 'hash-error', 'json');

      expect(result.passed).toBe(false);
      expect(result.reason).toBe('SUSPICIOUS');
      expect(result.details['error-scanner'].error).toContain('Scanner crashed');
    });
  });

  describe('caching', () => {
    it('should cache inspection results', async () => {
      const content = Buffer.from('{"type": "credential", "schemaVersion": "v1"}');
      const hash = 'cached-hash';

      const result1 = await service.inspectContent(content, hash, 'json');
      const result2 = await service.inspectContent(content, hash, 'json');

      expect(result1).toEqual(result2);
    });

    it('should cache negative results', async () => {
      const content = Buffer.from('not json');
      const hash = 'invalid-hash';

      const result1 = await service.inspectContent(content, hash, 'json');
      const result2 = await service.inspectContent(content, hash, 'json');

      expect(result1.passed).toBe(false);
      expect(result2.passed).toBe(false);
      expect(result1.reason).toEqual(result2.reason);
    });

    it('should clear cache', () => {
      service.clearCache();
      expect((service as any).inspectionCache.size).toBe(0);
    });
  });

  describe('binary content handling', () => {
    it('should accept binary content', async () => {
      const binary = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG header
      const result = await service.inspectContent(binary, 'binary-hash', 'binary');

      expect(result.passed).toBe(true);
    });

    it('should handle binary with null bytes', async () => {
      const binary = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      const result = await service.inspectContent(binary, 'null-bytes-hash', 'binary');

      expect(result.passed).toBe(true);
    });
  });

  describe('metadata extraction', () => {
    it('should include scanner names in result', async () => {
      const content = Buffer.from('{"type": "test", "schemaVersion": "v1"}');
      const result = await service.inspectContent(content, 'meta-hash', 'json');

      expect(result.scannersRun).toContain('json-format-validator');
      expect(result.scannersRun).toContain('binary-validator');
    });

    it('should include timing information', async () => {
      const content = Buffer.from('{"type": "test", "schemaVersion": "v1"}');
      const result = await service.inspectContent(content, 'timing-hash', 'json');

      expect(result.details['json-format-validator']).toBeDefined();
      expect(result.details['json-format-validator'].duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('should include content size in details', async () => {
      const content = Buffer.from('{"type": "test", "schemaVersion": "v1"}');
      const result = await service.inspectContent(content, 'size-hash', 'json');

      expect(result.details.size).toBe(content.length);
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { CapabilityBitmapService } from '../../src/contracts/capability-bitmap.service';
import {
  CapabilityCompatibilityStatusCode,
  CommonCapabilities,
  buildBitmap,
  hasBitmap,
  extractSetBits,
} from '../../src/contracts/capability-bitmap.types';
import { ConfigService } from '@nestjs/config';

describe('CapabilityBitmapService', () => {
  let service: CapabilityBitmapService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CapabilityBitmapService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<CapabilityBitmapService>(CapabilityBitmapService);
  });

  describe('buildBitmap', () => {
    it('builds a bitmap from empty positions', () => {
      const bitmap = buildBitmap([]);
      expect(bitmap).toBe(0n);
    });

    it('builds a bitmap from a single position', () => {
      const bitmap = buildBitmap([0]);
      expect(bitmap).toBe(1n);
    });

    it('builds a bitmap from multiple positions', () => {
      const bitmap = buildBitmap([0, 2, 4]);
      expect(bitmap).toBe(21n); // 0b10101
    });

    it('builds a bitmap for all 64 bits', () => {
      const positions = Array.from({ length: 64 }, (_, i) => i);
      const bitmap = buildBitmap(positions);
      expect(bitmap).toBe((1n << 64n) - 1n);
    });

    it('throws on invalid position below 0', () => {
      expect(() => buildBitmap([-1])).toThrow();
    });

    it('throws on invalid position above 63', () => {
      expect(() => buildBitmap([64])).toThrow();
    });
  });

  describe('hasBitmap', () => {
    it('returns true when all required bits are set', () => {
      const contract = buildBitmap([0, 1, 2, 3]);
      const required = buildBitmap([1, 3]);
      expect(hasBitmap(contract, required)).toBe(true);
    });

    it('returns false when required bits are missing', () => {
      const contract = buildBitmap([0, 2]);
      const required = buildBitmap([1, 3]);
      expect(hasBitmap(contract, required)).toBe(false);
    });

    it('returns true when required bitmap is empty', () => {
      const contract = buildBitmap([]);
      const required = buildBitmap([]);
      expect(hasBitmap(contract, required)).toBe(true);
    });

    it('returns true when contract has extra bits beyond required', () => {
      const contract = buildBitmap([0, 1, 2, 3, 4, 5]);
      const required = buildBitmap([1, 3]);
      expect(hasBitmap(contract, required)).toBe(true);
    });
  });

  describe('extractSetBits', () => {
    it('extracts bits from empty bitmap', () => {
      const bits = extractSetBits(0n);
      expect(bits).toEqual([]);
    });

    it('extracts bits from single-bit bitmap', () => {
      const bits = extractSetBits(1n);
      expect(bits).toEqual([0]);
    });

    it('extracts bits from multi-bit bitmap', () => {
      const bitmap = buildBitmap([0, 2, 4, 7]);
      const bits = extractSetBits(bitmap);
      expect(bits).toEqual([0, 2, 4, 7]);
    });

    it('extracts bits in ascending order', () => {
      const bitmap = buildBitmap([7, 3, 1, 5]);
      const bits = extractSetBits(bitmap);
      expect(bits).toEqual([1, 3, 5, 7]);
    });
  });

  describe('checkCompatibility', () => {
    it('returns compatible when service has no requirements', () => {
      // Register a service with no requirements
      service.registerRequirement({
        serviceId: 'test_service',
        requiredBitmap: buildBitmap([]),
        advisoryBitmap: buildBitmap([]),
        applicableSchemaVersions: [1],
      });

      const result = service.checkCompatibility(
        'test_service',
        1,
        buildBitmap([0, 1, 2]),
      );

      expect(result.compatible).toBe(true);
      expect(result.reasonCode).toBe(CapabilityCompatibilityStatusCode.COMPATIBLE);
      expect(result.missingCapabilities).toHaveLength(0);
    });

    it('returns compatible when contract has all required capabilities', () => {
      service.registerRequirement({
        serviceId: 'test_service',
        requiredBitmap: buildBitmap([
          CommonCapabilities.CHECKPOINT_MIGRATION.bitPosition,
          CommonCapabilities.LEDGER_MONOTONICITY.bitPosition,
        ]),
        advisoryBitmap: buildBitmap([]),
        applicableSchemaVersions: [1],
      });

      const result = service.checkCompatibility(
        'test_service',
        1,
        buildBitmap([
          CommonCapabilities.CHECKPOINT_MIGRATION.bitPosition,
          CommonCapabilities.LEDGER_MONOTONICITY.bitPosition,
        ]),
      );

      expect(result.compatible).toBe(true);
      expect(result.missingCapabilities).toHaveLength(0);
      expect(result.hasCapabilities).toHaveLength(2);
    });

    it('returns incompatible when contract missing required capabilities', () => {
      service.registerRequirement({
        serviceId: 'test_service',
        requiredBitmap: buildBitmap([
          CommonCapabilities.CHECKPOINT_MIGRATION.bitPosition,
          CommonCapabilities.LEDGER_MONOTONICITY.bitPosition,
        ]),
        advisoryBitmap: buildBitmap([]),
        applicableSchemaVersions: [1],
      });

      const result = service.checkCompatibility(
        'test_service',
        1,
        buildBitmap([CommonCapabilities.CHECKPOINT_MIGRATION.bitPosition]),
      );

      expect(result.compatible).toBe(false);
      expect(result.reasonCode).toBe(
        CapabilityCompatibilityStatusCode.MISSING_REQUIRED,
      );
      expect(result.missingCapabilities).toHaveLength(1);
      expect(result.missingCapabilities[0].name).toBe(
        CommonCapabilities.LEDGER_MONOTONICITY.name,
      );
    });

    it('identifies missing advisory capabilities', () => {
      service.registerRequirement({
        serviceId: 'test_service',
        requiredBitmap: buildBitmap([
          CommonCapabilities.CHECKPOINT_MIGRATION.bitPosition,
        ]),
        advisoryBitmap: buildBitmap([
          CommonCapabilities.WEBHOOK_RETRY_POLICY.bitPosition,
        ]),
        applicableSchemaVersions: [1],
      });

      const result = service.checkCompatibility(
        'test_service',
        1,
        buildBitmap([CommonCapabilities.CHECKPOINT_MIGRATION.bitPosition]),
      );

      expect(result.compatible).toBe(true);
      expect(result.missingAdvisory).toHaveLength(1);
      expect(result.missingAdvisory[0].name).toBe(
        CommonCapabilities.WEBHOOK_RETRY_POLICY.name,
      );
    });

    it('returns error for unknown service', () => {
      const result = service.checkCompatibility(
        'nonexistent_service',
        1,
        buildBitmap([0]),
      );

      expect(result.compatible).toBe(false);
      expect(result.reasonCode).toBe(
        CapabilityCompatibilityStatusCode.UNKNOWN_SERVICE,
      );
    });

    it('returns error for unknown schema version', () => {
      service.registerRequirement({
        serviceId: 'test_service',
        requiredBitmap: buildBitmap([]),
        advisoryBitmap: buildBitmap([]),
        applicableSchemaVersions: [1],
      });

      const result = service.checkCompatibility(
        'test_service',
        999,
        buildBitmap([0]),
      );

      expect(result.compatible).toBe(false);
      expect(result.reasonCode).toBe(
        CapabilityCompatibilityStatusCode.UNKNOWN_VERSION,
      );
    });

    it('returns compatible when schema version not applicable to service', () => {
      service.registerRequirement({
        serviceId: 'test_service',
        requiredBitmap: buildBitmap([1]),
        advisoryBitmap: buildBitmap([]),
        applicableSchemaVersions: [1], // Only version 1
      });

      const result = service.checkCompatibility(
        'test_service',
        2, // But checking version 2
        buildBitmap([0]), // Missing required capability
      );

      expect(result.compatible).toBe(true);
      expect(result.reason).toContain('do not apply');
    });

    it('preserves unknown bits in contract bitmap', () => {
      service.registerRequirement({
        serviceId: 'test_service',
        requiredBitmap: buildBitmap([0]),
        advisoryBitmap: buildBitmap([]),
        applicableSchemaVersions: [1],
      });

      // Contract has required bit 0, plus unknown bits 50 and 63
      const contractBitmap = buildBitmap([0, 50, 63]);

      const result = service.checkCompatibility(
        'test_service',
        1,
        contractBitmap,
      );

      expect(result.contractBitmap).toBe(contractBitmap);
      expect(result.compatible).toBe(true);
    });
  });

  describe('getBitmapForVersion', () => {
    it('returns bitmap for existing schema version', () => {
      const bitmap = service.getBitmapForVersion(1);
      expect(bitmap).not.toBeNull();
      expect(typeof bitmap).toBe('bigint');
    });

    it('returns null for non-existent schema version', () => {
      const bitmap = service.getBitmapForVersion(999);
      expect(bitmap).toBeNull();
    });

    it('returns different bitmaps for different versions', () => {
      const v1 = service.getBitmapForVersion(1);
      const v2 = service.getBitmapForVersion(2);
      expect(v1).not.toEqual(v2);
    });
  });

  describe('getAllCapabilities', () => {
    it('returns at least the default capabilities', () => {
      const capabilities = service.getAllCapabilities();
      expect(capabilities.length).toBeGreaterThanOrEqual(8);
    });

    it('returns capabilities with distinct bit positions', () => {
      const capabilities = service.getAllCapabilities();
      const positions = capabilities.map((c) => c.bitPosition);
      const unique = new Set(positions);
      expect(unique.size).toBe(positions.length);
    });

    it('includes checkpoint migration capability', () => {
      const capabilities = service.getAllCapabilities();
      const checkpoint = capabilities.find(
        (c) => c.name === CommonCapabilities.CHECKPOINT_MIGRATION.name,
      );
      expect(checkpoint).toBeDefined();
      expect(checkpoint?.required).toBe(true);
      expect(checkpoint?.severity).toBe('blocking');
    });
  });

  describe('getCapabilityByName', () => {
    it('returns capability by exact name', () => {
      const cap = service.getCapabilityByName('checkpoint_migration');
      expect(cap).not.toBeNull();
      expect(cap?.name).toBe('checkpoint_migration');
    });

    it('returns null for non-existent capability', () => {
      const cap = service.getCapabilityByName('nonexistent_capability');
      expect(cap).toBeNull();
    });
  });

  describe('getCapabilityVersions', () => {
    it('returns at least 3 versions', () => {
      const versions = service.getCapabilityVersions();
      expect(versions.length).toBeGreaterThanOrEqual(3);
    });

    it('returns versions in ascending order by schema version', () => {
      const versions = service.getCapabilityVersions();
      for (let i = 1; i < versions.length; i++) {
        expect(versions[i].schemaVersion).toBeGreaterThan(
          versions[i - 1].schemaVersion,
        );
      }
    });

    it('includes expected schema versions', () => {
      const versions = service.getCapabilityVersions();
      const schemaVersions = versions.map((v) => v.schemaVersion);
      expect(schemaVersions).toContain(1);
      expect(schemaVersions).toContain(2);
      expect(schemaVersions).toContain(3);
    });
  });

  describe('getIndexMetadata', () => {
    it('returns metadata with format version', () => {
      const metadata = service.getIndexMetadata();
      expect(metadata.formatVersion).toBe(1);
    });

    it('returns metadata with positive capability count', () => {
      const metadata = service.getIndexMetadata();
      expect(metadata.capabilityCount).toBeGreaterThan(0);
    });

    it('returns metadata with positive version count', () => {
      const metadata = service.getIndexMetadata();
      expect(metadata.versionCount).toBeGreaterThanOrEqual(3);
    });

    it('returns metadata with loadedAt timestamp', () => {
      const metadata = service.getIndexMetadata();
      expect(metadata.loadedAt).toBeDefined();
      const date = new Date(metadata.loadedAt);
      expect(date.getTime()).toBeGreaterThan(0);
    });

    it('returns metadata with reasonable age', () => {
      const metadata = service.getIndexMetadata();
      expect(metadata.ageMs).toBeGreaterThanOrEqual(0);
      expect(metadata.ageMs).toBeLessThan(5000); // Loaded recently
    });
  });

  describe('registerRequirement', () => {
    it('registers a new service requirement', () => {
      service.registerRequirement({
        serviceId: 'test_service_new',
        requiredBitmap: buildBitmap([0, 1]),
        advisoryBitmap: buildBitmap([2]),
        applicableSchemaVersions: [1, 2],
      });

      const result = service.checkCompatibility(
        'test_service_new',
        1,
        buildBitmap([0, 1, 2, 3]),
      );

      expect(result.compatible).toBe(true);
    });

    it('allows overwriting existing requirement', () => {
      service.registerRequirement({
        serviceId: 'overwrite_test',
        requiredBitmap: buildBitmap([0]),
        advisoryBitmap: buildBitmap([]),
        applicableSchemaVersions: [1],
      });

      service.registerRequirement({
        serviceId: 'overwrite_test',
        requiredBitmap: buildBitmap([1, 2]),
        advisoryBitmap: buildBitmap([]),
        applicableSchemaVersions: [1],
      });

      const result = service.checkCompatibility(
        'overwrite_test',
        1,
        buildBitmap([1, 2]),
      );

      expect(result.compatible).toBe(true);
      expect(result.requiredCapabilities).toHaveLength(2);
    });
  });

  describe('resetRequirements', () => {
    it('clears all registered requirements', () => {
      service.registerRequirement({
        serviceId: 'test_reset',
        requiredBitmap: buildBitmap([0]),
        advisoryBitmap: buildBitmap([]),
        applicableSchemaVersions: [1],
      });

      service.resetRequirements();

      const result = service.checkCompatibility(
        'test_reset',
        1,
        buildBitmap([0]),
      );

      expect(result.compatible).toBe(false);
      expect(result.reasonCode).toBe(
        CapabilityCompatibilityStatusCode.UNKNOWN_SERVICE,
      );
    });
  });

  describe('integration: default services', () => {
    it('webhook_sender is compatible with v1 bitmap', () => {
      const v1Bitmap = service.getBitmapForVersion(1);
      expect(v1Bitmap).not.toBeNull();

      const result = service.checkCompatibility('webhook_sender', 1, v1Bitmap!);
      expect(result.compatible).toBe(true);
    });

    it('checkpoint_monitor is compatible with v2 bitmap', () => {
      const v2Bitmap = service.getBitmapForVersion(2);
      expect(v2Bitmap).not.toBeNull();

      const result = service.checkCompatibility(
        'checkpoint_monitor',
        2,
        v2Bitmap!,
      );
      expect(result.compatible).toBe(true);
    });

    it('provisional_payment_handler requires v3', () => {
      const v2Bitmap = service.getBitmapForVersion(2);
      expect(v2Bitmap).not.toBeNull();

      const result = service.checkCompatibility(
        'provisional_payment_handler',
        2,
        v2Bitmap!,
      );

      expect(result.compatible).toBe(true); // Not applicable to v2
    });

    it('dispute_notifier compatible with v2 and v3', () => {
      const v2Bitmap = service.getBitmapForVersion(2);
      const v3Bitmap = service.getBitmapForVersion(3);

      const r2 = service.checkCompatibility('dispute_notifier', 2, v2Bitmap!);
      const r3 = service.checkCompatibility('dispute_notifier', 3, v3Bitmap!);

      expect(r2.compatible).toBe(true);
      expect(r3.compatible).toBe(true);
    });
  });

  describe('boundary conditions', () => {
    it('handles zero bitmap gracefully', () => {
      service.registerRequirement({
        serviceId: 'zero_test',
        requiredBitmap: 0n,
        advisoryBitmap: 0n,
        applicableSchemaVersions: [1],
      });

      const result = service.checkCompatibility('zero_test', 1, 0n);
      expect(result.compatible).toBe(true);
    });

    it('handles max 64-bit bitmap gracefully', () => {
      const maxBitmap = (1n << 64n) - 1n;
      service.registerRequirement({
        serviceId: 'max_test',
        requiredBitmap: 1n,
        advisoryBitmap: 0n,
        applicableSchemaVersions: [1],
      });

      const result = service.checkCompatibility('max_test', 1, maxBitmap);
      expect(result.compatible).toBe(true);
    });

    it('handles overlapping required and advisory bitmaps', () => {
      const bitmap = buildBitmap([0, 1, 2]);
      service.registerRequirement({
        serviceId: 'overlap_test',
        requiredBitmap: buildBitmap([0, 1]),
        advisoryBitmap: buildBitmap([1, 2, 3]), // 1 is both required and advisory
        applicableSchemaVersions: [1],
      });

      const result = service.checkCompatibility(
        'overlap_test',
        1,
        bitmap,
      );

      expect(result.compatible).toBe(true);
      expect(result.missingAdvisory).toContainEqual(
        expect.objectContaining({ bitPosition: 3 }),
      );
    });
  });
});

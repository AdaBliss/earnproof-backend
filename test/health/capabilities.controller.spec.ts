import { Test, TestingModule } from '@nestjs/testing';
import { CapabilitiesController } from '../../src/health/capabilities.controller';
import { CapabilityBitmapService } from '../../src/contracts/capability-bitmap.service';
import { ConfigService } from '@nestjs/config';
import { buildBitmap, CommonCapabilities } from '../../src/contracts/capability-bitmap.types';

describe('CapabilitiesController', () => {
  let controller: CapabilitiesController;
  let service: CapabilityBitmapService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CapabilitiesController],
      providers: [
        CapabilityBitmapService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get<CapabilitiesController>(CapabilitiesController);
    service = module.get<CapabilityBitmapService>(CapabilityBitmapService);
  });

  describe('getCapabilities', () => {
    it('returns capability document with contract features', () => {
      const mockRequest = {
        headers: {},
      } as any;

      const mockResponse = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn().mockReturnThis(),
      } as any;

      controller.getCapabilities(mockRequest, mockResponse);

      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalled();

      const capabilityDoc = mockResponse.json.mock.calls[0][0];
      expect(capabilityDoc).toHaveProperty('version');
      expect(capabilityDoc).toHaveProperty('features');
      expect(capabilityDoc.features).toHaveProperty('contracts');
      expect(capabilityDoc.features.contracts).toEqual({
        capabilityBitmap: true,
        successorMigration: true,
      });
    });

    it('includes capability bitmap in features', () => {
      const mockRequest = {
        headers: {},
      } as any;

      const mockResponse = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn().mockReturnThis(),
      } as any;

      controller.getCapabilities(mockRequest, mockResponse);

      const capabilityDoc = mockResponse.json.mock.calls[0][0];
      expect(capabilityDoc.features.contracts.capabilityBitmap).toBe(true);
    });

    it('includes max capability bit position in limits', () => {
      const mockRequest = {
        headers: {},
      } as any;

      const mockResponse = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn().mockReturnThis(),
      } as any;

      controller.getCapabilities(mockRequest, mockResponse);

      const capabilityDoc = mockResponse.json.mock.calls[0][0];
      expect(capabilityDoc.limits).toHaveProperty('maxCapabilityBitPosition');
      expect(capabilityDoc.limits.maxCapabilityBitPosition).toBe(63);
    });

    it('sets ETag header', () => {
      const mockRequest = {
        headers: {},
      } as any;

      const mockResponse = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn().mockReturnThis(),
      } as any;

      controller.getCapabilities(mockRequest, mockResponse);

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'ETag',
        expect.stringMatching(/^"[a-f0-9]{64}"$/),
      );
    });

    it('returns 304 NOT_MODIFIED when ETag matches', () => {
      const etag = '"abc123"';
      const mockRequest = {
        headers: { 'if-none-match': etag },
      } as any;

      const mockResponse = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis(),
      } as any;

      // First, compute what the ETag will be
      const capabilityDoc = {
        version: '1.0.0',
        minClientVersion: '1.0.0',
        network: process.env.STELLAR_NETWORK || 'testnet',
        features: {
          webhooks: { concurrencyLimits: true, partitionOrdering: true },
          apiKeys: { cidrAllowlist: true },
          securityNotifications: { outboxDelivery: true },
          contracts: { capabilityBitmap: true, successorMigration: true },
        },
        limits: {
          maxWebhooksPerOrg: 10,
          defaultApiKeyRateLimit: 1000,
          maxCapabilityBitPosition: 63,
        },
        deploymentId: process.env.DEPLOYMENT_ID || 'earnproof-backend-prod',
      };

      const crypto = require('crypto');
      const hash = crypto
        .createHash('sha256')
        .update(JSON.stringify(capabilityDoc))
        .digest('hex');
      const actualEtag = `"${hash}"`;

      const mockRequest2 = {
        headers: { 'if-none-match': actualEtag },
      } as any;

      const mockResponse2 = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis(),
        setHeader: jest.fn().mockReturnThis(),
      } as any;

      controller.getCapabilities(mockRequest2, mockResponse2);

      expect(mockResponse2.status).toHaveBeenCalledWith(304);
      expect(mockResponse2.send).toHaveBeenCalled();
    });

    it('sets cache control headers', () => {
      const mockRequest = {
        headers: {},
      } as any;

      const mockResponse = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn().mockReturnThis(),
      } as any;

      controller.getCapabilities(mockRequest, mockResponse);

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'public, max-age=300, must-revalidate',
      );
    });
  });

  describe('getCapabilityMetadata', () => {
    it('returns metadata object', () => {
      const metadata = controller.getCapabilityMetadata();

      expect(metadata).toHaveProperty('formatVersion');
      expect(metadata).toHaveProperty('capabilityCount');
      expect(metadata).toHaveProperty('versionCount');
      expect(metadata).toHaveProperty('loadedAt');
      expect(metadata).toHaveProperty('ageMs');
    });

    it('returns non-negative age', () => {
      const metadata = controller.getCapabilityMetadata();
      expect(metadata.ageMs).toBeGreaterThanOrEqual(0);
    });

    it('returns positive capability count', () => {
      const metadata = controller.getCapabilityMetadata();
      expect(metadata.capabilityCount).toBeGreaterThan(0);
    });

    it('returns version count of at least 3', () => {
      const metadata = controller.getCapabilityMetadata();
      expect(metadata.versionCount).toBeGreaterThanOrEqual(3);
    });
  });

  describe('listCapabilityDefinitions', () => {
    it('returns list of capabilities', () => {
      const response = controller.listCapabilityDefinitions();

      expect(response).toHaveProperty('total');
      expect(response).toHaveProperty('capabilities');
      expect(Array.isArray(response.capabilities)).toBe(true);
    });

    it('total count matches capabilities array length', () => {
      const response = controller.listCapabilityDefinitions();
      expect(response.total).toBe(response.capabilities.length);
    });

    it('each capability has required properties', () => {
      const response = controller.listCapabilityDefinitions();

      for (const cap of response.capabilities) {
        expect(cap).toHaveProperty('bitPosition');
        expect(cap).toHaveProperty('name');
        expect(cap).toHaveProperty('description');
        expect(cap).toHaveProperty('introducedInVersion');
        expect(cap).toHaveProperty('severity');
        expect(cap).toHaveProperty('required');
      }
    });

    it('includes checkpoint migration capability', () => {
      const response = controller.listCapabilityDefinitions();
      const checkpoint = response.capabilities.find(
        (c) => c.name === 'checkpoint_migration',
      );

      expect(checkpoint).toBeDefined();
      expect(checkpoint?.required).toBe(true);
      expect(checkpoint?.severity).toBe('blocking');
    });

    it('bit positions are unique', () => {
      const response = controller.listCapabilityDefinitions();
      const positions = response.capabilities.map((c) => c.bitPosition);
      const unique = new Set(positions);

      expect(unique.size).toBe(positions.length);
    });

    it('bit positions are within valid range [0, 63]', () => {
      const response = controller.listCapabilityDefinitions();

      for (const cap of response.capabilities) {
        expect(cap.bitPosition).toBeGreaterThanOrEqual(0);
        expect(cap.bitPosition).toBeLessThanOrEqual(63);
      }
    });
  });

  describe('listCapabilityVersions', () => {
    it('returns list of versions', () => {
      const response = controller.listCapabilityVersions();

      expect(response).toHaveProperty('total');
      expect(response).toHaveProperty('versions');
      expect(Array.isArray(response.versions)).toBe(true);
    });

    it('total count matches versions array length', () => {
      const response = controller.listCapabilityVersions();
      expect(response.total).toBe(response.versions.length);
    });

    it('each version has required properties', () => {
      const response = controller.listCapabilityVersions();

      for (const version of response.versions) {
        expect(version).toHaveProperty('schemaVersion');
        expect(version).toHaveProperty('bitmap');
        expect(version).toHaveProperty('definedAt');
        expect(version).toHaveProperty('capabilities');
      }
    });

    it('bitmap is a string (JSON-safe)', () => {
      const response = controller.listCapabilityVersions();

      for (const version of response.versions) {
        expect(typeof version.bitmap).toBe('string');
        expect(/^\d+$/.test(version.bitmap)).toBe(true);
      }
    });

    it('versions have at least 3 entries', () => {
      const response = controller.listCapabilityVersions();
      expect(response.versions.length).toBeGreaterThanOrEqual(3);
    });

    it('versions include schema versions 1, 2, 3', () => {
      const response = controller.listCapabilityVersions();
      const schemaVersions = response.versions.map((v) => v.schemaVersion);

      expect(schemaVersions).toContain(1);
      expect(schemaVersions).toContain(2);
      expect(schemaVersions).toContain(3);
    });
  });

  describe('checkCompatibility', () => {
    it('returns compatible result for compatible service', () => {
      const v1Bitmap = service.getBitmapForVersion(1);
      expect(v1Bitmap).not.toBeNull();

      const response = controller.checkCompatibility({
        serviceId: 'webhook_sender',
        schemaVersion: 1,
        contractBitmap: v1Bitmap!.toString(),
      });

      expect(response.compatible).toBe(true);
      expect(response.reasonCode).toBe('compatible');
      expect(response.missingCapabilities).toHaveLength(0);
    });

    it('returns incompatible result when capabilities missing', () => {
      const response = controller.checkCompatibility({
        serviceId: 'webhook_sender',
        schemaVersion: 1,
        contractBitmap: '0', // No capabilities
      });

      expect(response.compatible).toBe(false);
      expect(response.reasonCode).toBe('missing_required_capabilities');
      expect(response.missingCapabilities.length).toBeGreaterThan(0);
    });

    it('returns error for unknown service', () => {
      const response = controller.checkCompatibility({
        serviceId: 'nonexistent_service',
        schemaVersion: 1,
        contractBitmap: '15',
      });

      expect(response.compatible).toBe(false);
      expect(response.reasonCode).toBe('unknown_service');
    });

    it('returns error for unknown schema version', () => {
      const response = controller.checkCompatibility({
        serviceId: 'webhook_sender',
        schemaVersion: 999,
        contractBitmap: '15',
      });

      expect(response.compatible).toBe(false);
      expect(response.reasonCode).toBe('unknown_schema_version');
    });

    it('returns error for invalid bitmap format', () => {
      const response = controller.checkCompatibility({
        serviceId: 'webhook_sender',
        schemaVersion: 1,
        contractBitmap: 'not_a_number',
      });

      expect(response.compatible).toBe(false);
      expect(response.reasonCode).toBe('invalid_bitmap');
      expect(response.reason).toContain('valid integer');
    });

    it('includes required capabilities in response', () => {
      const response = controller.checkCompatibility({
        serviceId: 'webhook_sender',
        schemaVersion: 1,
        contractBitmap: buildBitmap([0, 1, 3]).toString(),
      });

      expect(response.requiredCapabilities).toBeDefined();
      expect(response.requiredCapabilities.length).toBeGreaterThan(0);
    });

    it('includes has capabilities in response', () => {
      const response = controller.checkCompatibility({
        serviceId: 'webhook_sender',
        schemaVersion: 1,
        contractBitmap: buildBitmap([1, 3]).toString(),
      });

      expect(response.hasCapabilities).toBeDefined();
      expect(response.hasCapabilities.length).toBeGreaterThan(0);
    });

    it('identifies advisory capabilities', () => {
      const response = controller.checkCompatibility({
        serviceId: 'webhook_sender',
        schemaVersion: 1,
        contractBitmap: buildBitmap([1, 3]).toString(), // Missing webhook_retry_policy (advisory)
      });

      expect(response.missingAdvisory).toBeDefined();
      expect(response.missingAdvisory.length).toBeGreaterThan(0);
    });

    it('converts bitmap to string in response', () => {
      const bitmap = buildBitmap([0, 1, 2, 3]).toString();
      const response = controller.checkCompatibility({
        serviceId: 'webhook_sender',
        schemaVersion: 1,
        contractBitmap: bitmap,
      });

      expect(typeof response.contractBitmap).toBe('string');
      expect(response.contractBitmap).toBe(bitmap);
    });

    it('preserves unknown bits in bitmap', () => {
      const bitmap = buildBitmap([0, 1, 3, 50, 63]); // Unknown bits 50, 63
      const response = controller.checkCompatibility({
        serviceId: 'webhook_sender',
        schemaVersion: 1,
        contractBitmap: bitmap.toString(),
      });

      expect(response.contractBitmap).toBe(bitmap.toString());
    });
  });

  describe('integration', () => {
    it('capabilities endpoint exposes bitmap feature', () => {
      const mockRequest = {
        headers: {},
      } as any;

      const mockResponse = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn().mockReturnThis(),
      } as any;

      controller.getCapabilities(mockRequest, mockResponse);

      const capabilityDoc = mockResponse.json.mock.calls[0][0];
      expect(capabilityDoc.features.contracts.capabilityBitmap).toBe(true);
    });

    it('metadata reflects actual indexed capabilities', () => {
      const metadata = controller.getCapabilityMetadata();
      const definitions = controller.listCapabilityDefinitions();

      expect(metadata.capabilityCount).toBe(definitions.total);
    });

    it('metadata reflects actual indexed versions', () => {
      const metadata = controller.getCapabilityMetadata();
      const versions = controller.listCapabilityVersions();

      expect(metadata.versionCount).toBe(versions.total);
    });

    it('compatibility check references indexed definitions', () => {
      const v1Bitmap = service.getBitmapForVersion(1);
      const response = controller.checkCompatibility({
        serviceId: 'webhook_sender',
        schemaVersion: 1,
        contractBitmap: v1Bitmap!.toString(),
      });

      const definitions = controller.listCapabilityDefinitions();
      for (const cap of response.requiredCapabilities) {
        const found = definitions.capabilities.find((d) => d.name === cap.name);
        expect(found).toBeDefined();
      }
    });
  });

  describe('authorization and privacy', () => {
    it('does not expose secrets in definitions', () => {
      const response = controller.listCapabilityDefinitions();

      for (const cap of response.capabilities) {
        expect(cap.description).not.toMatch(/(secret|key|password|token|credential)/i);
        expect(cap.name).not.toMatch(/(secret|key|password|token|credential)/i);
      }
    });

    it('does not expose addresses in definitions', () => {
      const response = controller.listCapabilityDefinitions();

      for (const cap of response.capabilities) {
        expect(cap.description).not.toMatch(/0x[0-9a-f]{40,}/i);
        expect(cap.description).not.toMatch(/[GS][A-Z0-9]{54}/);
      }
    });

    it('compatibility response is privacy-safe', () => {
      const response = controller.checkCompatibility({
        serviceId: 'webhook_sender',
        schemaVersion: 1,
        contractBitmap: '15',
      });

      const jsonStr = JSON.stringify(response);
      expect(jsonStr).not.toMatch(/(secret|password|token|credential)/i);
    });
  });
});

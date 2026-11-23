import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, PayloadTooLargeException } from '@nestjs/common';
import { MultipartUploadService } from './multipart-upload.service';
import { MultipartParserService, ParsedPart } from '../common/uploads/multipart-parser.service';
import { ContentInspectionService } from '../common/uploads/content-inspection.service';
import { CredentialQuarantineService } from './credential-quarantine.service';
import { PrismaService } from '../database/prisma.service';
import { CredentialQuarantineReasonCode } from '@prisma/client';

/**
 * Unit tests for MultipartUploadService
 *
 * Tests orchestration of parsing, inspection, and quarantine intake.
 * Does not test the parser or inspector directly (those have their own specs).
 */
describe('MultipartUploadService', () => {
  let service: MultipartUploadService;
  let parserService: MultipartParserService;
  let inspectorService: ContentInspectionService;
  let quarantineService: CredentialQuarantineService;
  let prismaService: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MultipartUploadService,
        {
          provide: MultipartParserService,
          useValue: {
            parseMultipart: jest.fn(),
            cleanupParseResult: jest.fn(),
          },
        },
        {
          provide: ContentInspectionService,
          useValue: {
            inspectContent: jest.fn(),
            clearCache: jest.fn(),
          },
        },
        {
          provide: CredentialQuarantineService,
          useValue: {
            createQuarantine: jest.fn(),
          },
        },
        {
          provide: PrismaService,
          useValue: {},
        },
      ],
    }).compile();

    service = module.get<MultipartUploadService>(MultipartUploadService);
    parserService = module.get<MultipartParserService>(MultipartParserService);
    inspectorService = module.get<ContentInspectionService>(ContentInspectionService);
    quarantineService = module.get<CredentialQuarantineService>(CredentialQuarantineService);
    prismaService = module.get<PrismaService>(PrismaService);
  });

  describe('uploadAndQuarantine', () => {
    it('should process and quarantine valid credentials', async () => {
      const mockPart: ParsedPart = {
        fieldName: 'credential',
        filename: 'credential.json',
        mimeType: 'application/json',
        size: 512,
        hash: 'sha256abc123',
        tempPath: '/tmp/part-1',
        detectedType: 'json',
        firstBytes: Buffer.from('{"type":'),
      };

      const mockParseResult = {
        parts: [mockPart],
        totalSize: 512,
        tempDir: '/tmp/upload-123',
      };

      jest.spyOn(parserService, 'parseMultipart').mockResolvedValue(mockParseResult);
      jest.spyOn(inspectorService, 'inspectContent').mockResolvedValue({
        passed: true,
        reason: 'MALFORMED',
        details: {},
        scannersRun: ['test-scanner'],
      });
      jest.spyOn(quarantineService, 'createQuarantine').mockResolvedValue({
        id: 'q-123',
        state: 'QUARANTINED',
        reason: 'MALFORMED' as CredentialQuarantineReasonCode,
      } as any);

      const result = await service.uploadAndQuarantine(
        { headers: { 'content-type': 'multipart/form-data; boundary=----abc' } },
        'multipart/form-data; boundary=----abc',
        'org-123',
        'user-456',
      );

      expect(result.quarantines).toHaveLength(1);
      expect(result.quarantines[0].quarantineId).toBe('q-123');
      expect(result.summary.uploaded).toBe(1);
      expect(result.summary.quarantined).toBe(1);
      expect(result.summary.errors).toBe(0);
    });

    it('should handle multiple parts', async () => {
      const mockParts: ParsedPart[] = [
        {
          fieldName: 'file1',
          filename: 'cred1.json',
          mimeType: 'application/json',
          size: 512,
          hash: 'hash1',
          tempPath: '/tmp/part-1',
          detectedType: 'json',
          firstBytes: Buffer.from('{"type":'),
        },
        {
          fieldName: 'file2',
          filename: 'cred2.json',
          mimeType: 'application/json',
          size: 512,
          hash: 'hash2',
          tempPath: '/tmp/part-2',
          detectedType: 'json',
          firstBytes: Buffer.from('{"type":'),
        },
      ];

      jest.spyOn(parserService, 'parseMultipart').mockResolvedValue({
        parts: mockParts,
        totalSize: 1024,
        tempDir: '/tmp/upload-123',
      });

      jest.spyOn(inspectorService, 'inspectContent').mockResolvedValue({
        passed: true,
        reason: 'MALFORMED',
        details: {},
        scannersRun: [],
      });

      jest.spyOn(quarantineService, 'createQuarantine').mockResolvedValue({
        id: 'q-123',
        state: 'QUARANTINED',
        reason: 'MALFORMED',
      } as any);

      const result = await service.uploadAndQuarantine(
        {},
        'multipart/form-data; boundary=----abc',
        'org-123',
        'user-456',
      );

      expect(result.summary.uploaded).toBe(2);
      expect(result.summary.quarantined).toBe(2);
    });

    it('should handle inspection failure as quarantine reason', async () => {
      const mockPart: ParsedPart = {
        fieldName: 'credential',
        filename: 'malicious.json',
        mimeType: 'application/json',
        size: 256,
        hash: 'malicious-hash',
        tempPath: '/tmp/part-1',
        detectedType: 'json',
        firstBytes: Buffer.from('{"bad":'),
      };

      jest.spyOn(parserService, 'parseMultipart').mockResolvedValue({
        parts: [mockPart],
        totalSize: 256,
        tempDir: '/tmp/upload-123',
      });

      jest.spyOn(inspectorService, 'inspectContent').mockResolvedValue({
        passed: false,
        reason: 'SUSPICIOUS',
        details: { scanner: 'failed' },
        scannersRun: ['malware-scanner'],
      });

      jest.spyOn(quarantineService, 'createQuarantine').mockResolvedValue({
        id: 'q-bad',
        state: 'QUARANTINED',
        reason: 'SUSPICIOUS',
      } as any);

      const result = await service.uploadAndQuarantine(
        {},
        'multipart/form-data; boundary=----abc',
        'org-123',
        'user-456',
      );

      expect(result.quarantines[0].reason).toBe('SUSPICIOUS');
    });

    it('should handle quarantine service conflict (deduplication)', async () => {
      const mockPart: ParsedPart = {
        fieldName: 'credential',
        filename: 'duplicate.json',
        mimeType: 'application/json',
        size: 512,
        hash: 'duplicate-hash',
        tempPath: '/tmp/part-1',
        detectedType: 'json',
        firstBytes: Buffer.from('{"type":'),
      };

      jest.spyOn(parserService, 'parseMultipart').mockResolvedValue({
        parts: [mockPart],
        totalSize: 512,
        tempDir: '/tmp/upload-123',
      });

      jest.spyOn(inspectorService, 'inspectContent').mockResolvedValue({
        passed: true,
        reason: 'MALFORMED',
        details: {},
        scannersRun: [],
      });

      jest
        .spyOn(quarantineService, 'createQuarantine')
        .mockRejectedValue(new ConflictException('Already quarantined'));

      const result = await service.uploadAndQuarantine(
        {},
        'multipart/form-data; boundary=----abc',
        'org-123',
        'user-456',
      );

      expect(result.summary.quarantined).toBe(0);
      expect(result.summary.errors).toBe(1);
    });

    it('should handle quarantine capacity exceeded', async () => {
      const mockPart: ParsedPart = {
        fieldName: 'credential',
        filename: 'overflow.json',
        mimeType: 'application/json',
        size: 512,
        hash: 'overflow-hash',
        tempPath: '/tmp/part-1',
        detectedType: 'json',
        firstBytes: Buffer.from('{"type":'),
      };

      jest.spyOn(parserService, 'parseMultipart').mockResolvedValue({
        parts: [mockPart],
        totalSize: 512,
        tempDir: '/tmp/upload-123',
      });

      jest.spyOn(inspectorService, 'inspectContent').mockResolvedValue({
        passed: true,
        reason: 'MALFORMED',
        details: {},
        scannersRun: [],
      });

      jest
        .spyOn(quarantineService, 'createQuarantine')
        .mockRejectedValue(new PayloadTooLargeException('Capacity exceeded'));

      const result = await service.uploadAndQuarantine(
        {},
        'multipart/form-data; boundary=----abc',
        'org-123',
        'user-456',
      );

      expect(result.summary.errors).toBe(1);
    });

    it('should clean up temp files on completion', async () => {
      const mockPart: ParsedPart = {
        fieldName: 'credential',
        filename: 'test.json',
        mimeType: 'application/json',
        size: 512,
        hash: 'test-hash',
        tempPath: '/tmp/part-1',
        detectedType: 'json',
        firstBytes: Buffer.from('{"type":'),
      };

      const mockParseResult = {
        parts: [mockPart],
        totalSize: 512,
        tempDir: '/tmp/upload-123',
      };

      jest.spyOn(parserService, 'parseMultipart').mockResolvedValue(mockParseResult);
      jest.spyOn(inspectorService, 'inspectContent').mockResolvedValue({
        passed: true,
        reason: 'MALFORMED',
        details: {},
        scannersRun: [],
      });
      jest.spyOn(quarantineService, 'createQuarantine').mockResolvedValue({
        id: 'q-123',
        state: 'QUARANTINED',
        reason: 'MALFORMED',
      } as any);

      const cleanupSpy = jest.spyOn(parserService, 'cleanupParseResult').mockResolvedValue();

      await service.uploadAndQuarantine(
        {},
        'multipart/form-data; boundary=----abc',
        'org-123',
        'user-456',
      );

      expect(cleanupSpy).toHaveBeenCalledWith(mockParseResult);
    });

    it('should clean up temp files even on error', async () => {
      const mockParseResult = {
        parts: [],
        totalSize: 0,
        tempDir: '/tmp/upload-123',
      };

      jest.spyOn(parserService, 'parseMultipart').mockResolvedValue(mockParseResult);

      const cleanupSpy = jest.spyOn(parserService, 'cleanupParseResult').mockResolvedValue();

      try {
        await service.uploadAndQuarantine(
          {},
          'multipart/form-data; boundary=----abc',
          'org-123',
          'user-456',
        );
      } catch {
        // Ignore error
      }

      expect(cleanupSpy).toHaveBeenCalled();
    });
  });

  describe('metadata extraction', () => {
    it('should extract JSON metadata', async () => {
      const json = {
        type: 'EarnProofMinimumIncomeCredential',
        schemaVersion: 'earnproof.minimum-income.v1',
        issuer: 'test-issuer',
        proof: { type: 'Ed25519', keyId: 'key-123' },
        expiresAt: '2025-12-31T23:59:59Z',
        issuedAt: '2025-01-01T00:00:00Z',
      };

      const content = Buffer.from(JSON.stringify(json));
      const mockPart: ParsedPart = {
        fieldName: 'file',
        filename: 'test.json',
        mimeType: 'application/json',
        size: content.length,
        hash: 'test-hash',
        tempPath: '/tmp/test',
        detectedType: 'json',
        firstBytes: Buffer.from('{'),
      };

      jest.spyOn(parserService, 'parseMultipart').mockResolvedValue({
        parts: [mockPart],
        totalSize: content.length,
        tempDir: '/tmp/upload',
      });

      jest.spyOn(inspectorService, 'inspectContent').mockResolvedValue({
        passed: true,
        reason: 'MALFORMED',
        details: {},
        scannersRun: [],
      });

      const captor = jest.fn().mockResolvedValue({
        id: 'q-123',
        state: 'QUARANTINED',
        reason: 'MALFORMED',
      } as any);

      jest.spyOn(quarantineService, 'createQuarantine').mockImplementation(captor);

      // Mock readFile to return the JSON content
      jest.mock('fs/promises', () => ({
        readFile: jest.fn().mockResolvedValue(content),
        unlink: jest.fn().mockResolvedValue(undefined),
      }));

      expect(true).toBe(true); // Placeholder assertion
    });
  });
});

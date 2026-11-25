/**
 * Unit and Integration Tests for Schema Replacement Service (#395)
 * 
 * Focused test coverage for:
 * - Schema replacement initialization with cycle detection
 * - Cross-network lineage rejection
 * - Organization acknowledgements
 * - Readiness assessment with findings
 * - TTL-based caching
 * - Deterministic status codes
 */

import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { SchemaReplacementService } from "./schema-replacement.service";
import { PrismaService } from "../database/prisma.service";
import {
  SchemaReplacementStatus,
  SchemaReplacementAcknowledgementStatus,
  ProofType,
  SchemaLifecycleStatus,
} from "@prisma/client";
import {
  SchemaReplacementReadinessStatusCode,
} from "./schema-replacement.types";

describe("SchemaReplacementService", () => {
  let service: SchemaReplacementService;
  let prisma: PrismaService;

  const mockPrismaService = {
    protocolSchema: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    schemaReplacementNotice: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    schemaReplacementAcknowledgement: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    organization: {
      findUnique: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchemaReplacementService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<SchemaReplacementService>(SchemaReplacementService);
    prisma = module.get<PrismaService>(PrismaService);

    // Reset mocks
    jest.clearAllMocks();
  });

  describe("initiateReplacement", () => {
    const baseInput = {
      predecessorSchemaId: "pred-123",
      successorSchemaId: "succ-456",
      deprecationDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      initiatedBy: "actor-789",
    };

    const mockPredecessor = {
      id: "pred-123",
      schemaId: "income-v1",
      version: "1.0",
      proofType: ProofType.MINIMUM_INCOME,
      status: SchemaLifecycleStatus.ACTIVE,
      network: "testnet",
      contractCompatible: true,
      maxPayloadBytes: 65536,
      definition: {},
      configVersion: "1.0",
      contractId: null,
      predecessorId: null,
      activatedAt: new Date(),
      deprecatedAt: null,
      sunsetAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockSuccessor = {
      ...mockPredecessor,
      id: "succ-456",
      schemaId: "income-v2",
      version: "2.0",
    };

    it("should create a schema replacement notice with valid inputs", async () => {
      const mockNotice = {
        id: "notice-123",
        ...baseInput,
        successorSchemaId: "succ-456",
        status: SchemaReplacementStatus.PENDING,
        initiatedAt: new Date(),
        sunsetDeadline: null,
        reason: null,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (prisma.protocolSchema.findUnique as jest.Mock)
        .mockResolvedValueOnce(mockPredecessor)
        .mockResolvedValueOnce(mockSuccessor);

      (prisma.schemaReplacementNotice.findFirst as jest.Mock).mockResolvedValue(null);

      (prisma.protocolSchema.findMany as jest.Mock).mockResolvedValue([]);

      (prisma.schemaReplacementNotice.create as jest.Mock).mockResolvedValue(mockNotice);

      const result = await service.initiateReplacement(baseInput);

      expect(result.id).toBe("notice-123");
      expect(result.status).toBe(SchemaReplacementStatus.PENDING);
      expect(result.predecessorSchemaName).toBe("income-v1");
      expect(result.successorSchemaName).toBe("income-v2");
    });

    it("should reject self-referential replacement", async () => {
      const input = {
        ...baseInput,
        successorSchemaId: baseInput.predecessorSchemaId,
      };

      (prisma.protocolSchema.findUnique as jest.Mock).mockResolvedValue(mockPredecessor);

      await expect(service.initiateReplacement(input)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should reject cross-network replacement", async () => {
      const successorOnDifferentNetwork = {
        ...mockSuccessor,
        network: "public",
      };

      (prisma.protocolSchema.findUnique as jest.Mock)
        .mockResolvedValueOnce(mockPredecessor)
        .mockResolvedValueOnce(successorOnDifferentNetwork);

      await expect(service.initiateReplacement(baseInput)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should reject replacement cycle", async () => {
      (prisma.protocolSchema.findUnique as jest.Mock)
        .mockResolvedValueOnce(mockPredecessor)
        .mockResolvedValueOnce(mockSuccessor);

      (prisma.schemaReplacementNotice.findFirst as jest.Mock).mockResolvedValue(null);

      // Successor is already a predecessor
      (prisma.protocolSchema.findMany as jest.Mock).mockResolvedValue([
        { id: "tertiary-789" },
      ]);

      await expect(service.initiateReplacement(baseInput)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should reject missing predecessor schema", async () => {
      (prisma.protocolSchema.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.initiateReplacement(baseInput)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should reject future deprecation deadline in past", async () => {
      const pastInput = {
        ...baseInput,
        deprecationDeadline: new Date(Date.now() - 1000),
      };

      (prisma.protocolSchema.findUnique as jest.Mock)
        .mockResolvedValueOnce(mockPredecessor)
        .mockResolvedValueOnce(mockSuccessor);

      await expect(service.initiateReplacement(pastInput)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should reject sunset deadline before deprecation deadline", async () => {
      const futureInput = {
        ...baseInput,
        sunsetDeadline: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000), // 10 days
      };

      (prisma.protocolSchema.findUnique as jest.Mock)
        .mockResolvedValueOnce(mockPredecessor)
        .mockResolvedValueOnce(mockSuccessor);

      await expect(service.initiateReplacement(futureInput)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should reject duplicate active notice", async () => {
      (prisma.protocolSchema.findUnique as jest.Mock)
        .mockResolvedValueOnce(mockPredecessor)
        .mockResolvedValueOnce(mockSuccessor);

      (prisma.protocolSchema.findMany as jest.Mock).mockResolvedValue([]);

      (prisma.schemaReplacementNotice.findFirst as jest.Mock).mockResolvedValue({
        id: "existing-notice",
      });

      await expect(service.initiateReplacement(baseInput)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe("acknowledgeReplacement", () => {
    const noticeId = "notice-123";
    const input = {
      organizationId: "org-456",
      acknowledgedBy: "actor-789",
      actionTaken: "MIGRATED_PROOFS",
    };

    const mockNotice = {
      id: noticeId,
      predecessorSchemaId: "pred-123",
      successorSchemaId: "succ-456",
      status: SchemaReplacementStatus.PENDING,
      initiatedBy: "admin-000",
      initiatedAt: new Date(),
      deprecationDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      sunsetDeadline: null,
      reason: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      predecessorSchema: { schemaId: "income-v1" },
      successorSchema: { schemaId: "income-v2" },
      acknowledgements: [],
    };

    it("should acknowledge a replacement notice", async () => {
      const mockAck = {
        id: "ack-001",
        noticeId,
        organizationId: "org-456",
        acknowledgedBy: "actor-789",
        acknowledgedAt: new Date(),
        status: SchemaReplacementAcknowledgementStatus.ACTED,
        actionTaken: "MIGRATED_PROOFS",
        actionAt: new Date(),
        note: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (prisma.schemaReplacementNotice.findUnique as jest.Mock).mockResolvedValue(
        mockNotice,
      );
      (prisma.organization.findUnique as jest.Mock).mockResolvedValue({
        id: "org-456",
        name: "Test Org",
      });
      (prisma.schemaReplacementAcknowledgement.findUnique as jest.Mock).mockResolvedValue(
        null,
      );
      (prisma.schemaReplacementAcknowledgement.create as jest.Mock).mockResolvedValue(
        mockAck,
      );

      const result = await service.acknowledgeReplacement(noticeId, input);

      expect(result.id).toBe("ack-001");
      expect(result.status).toBe(SchemaReplacementAcknowledgementStatus.ACTED);
      expect(result.actionTaken).toBe("MIGRATED_PROOFS");
    });

    it("should reject duplicate acknowledgement", async () => {
      (prisma.schemaReplacementNotice.findUnique as jest.Mock).mockResolvedValue(
        mockNotice,
      );
      (prisma.organization.findUnique as jest.Mock).mockResolvedValue({
        id: "org-456",
        name: "Test Org",
      });
      (prisma.schemaReplacementAcknowledgement.findUnique as jest.Mock).mockResolvedValue(
        { id: "ack-001" }, // Already acknowledged
      );

      await expect(
        service.acknowledgeReplacement(noticeId, input),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("assessReadiness", () => {
    it("should return ready status when conditions are met", async () => {
      const noticeId = "notice-123";

      const mockNotice = {
        id: noticeId,
        predecessorSchemaId: "pred-123",
        successorSchemaId: "succ-456",
        status: SchemaReplacementStatus.PENDING,
        initiatedBy: "admin-000",
        initiatedAt: new Date(),
        deprecationDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        sunsetDeadline: null,
        reason: null,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        predecessorSchema: { schemaId: "income-v1", network: "testnet" },
        successorSchema: { schemaId: "income-v2", network: "testnet" },
        acknowledgements: [
          {
            id: "ack-1",
            organizationId: "org-1",
            status: SchemaReplacementAcknowledgementStatus.ACTED,
          },
        ],
      };

      (prisma.schemaReplacementNotice.findUnique as jest.Mock).mockResolvedValue(
        mockNotice,
      );
      (prisma.schemaReplacementAcknowledgement.findMany as jest.Mock).mockResolvedValue(
        mockNotice.acknowledgements,
      );

      const result = await service.assessReadiness(noticeId);

      expect(result.status).toBe("ready");
      expect(result.findings).toHaveLength(0);
      expect(result.overallSeverity).toBe("none");
    });

    it("should return not_ready with blocking findings", async () => {
      const noticeId = "notice-123";

      const mockNotice = {
        id: noticeId,
        predecessorSchemaId: "pred-123",
        successorSchemaId: "succ-456",
        status: SchemaReplacementStatus.PENDING,
        initiatedBy: "admin-000",
        initiatedAt: new Date(),
        deprecationDeadline: new Date(Date.now() - 1000), // In the past
        sunsetDeadline: null,
        reason: null,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        predecessorSchema: { schemaId: "income-v1", network: "testnet" },
        successorSchema: { schemaId: "income-v2", network: "testnet" },
        acknowledgements: [],
      };

      (prisma.schemaReplacementNotice.findUnique as jest.Mock).mockResolvedValue(
        mockNotice,
      );
      (prisma.schemaReplacementAcknowledgement.findMany as jest.Mock).mockResolvedValue(
        [],
      );

      const result = await service.assessReadiness(noticeId);

      expect(result.status).toBe("not_ready");
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.overallSeverity).toMatch(/blocking|advisory/);
    });
  });

  describe("caching", () => {
    it("should return cached result if fresh", async () => {
      const noticeId = "notice-123";

      service.resetCache(); // Ensure clean state

      const mockNotice = {
        id: noticeId,
        predecessorSchemaId: "pred-123",
        successorSchemaId: "succ-456",
        status: SchemaReplacementStatus.PENDING,
        initiatedBy: "admin-000",
        initiatedAt: new Date(),
        deprecationDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        sunsetDeadline: null,
        reason: null,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        predecessorSchema: { schemaId: "income-v1", network: "testnet" },
        successorSchema: { schemaId: "income-v2", network: "testnet" },
        acknowledgements: [],
      };

      (prisma.schemaReplacementNotice.findUnique as jest.Mock).mockResolvedValue(
        mockNotice,
      );
      (prisma.schemaReplacementAcknowledgement.findMany as jest.Mock).mockResolvedValue(
        [],
      );

      // First call: not cached
      const result1 = await service.assessReadiness(noticeId);
      expect(result1.cached).toBeUndefined();

      // Clear mock call count
      (prisma.schemaReplacementNotice.findUnique as jest.Mock).mockClear();

      // Second call: should be cached (within 60s TTL)
      const result2 = await service.assessReadiness(noticeId);
      expect(result2.cached).toBe(true);

      // Prisma should not be called for cached result
      expect(prisma.schemaReplacementNotice.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("deterministic status codes", () => {
    it("should use deterministic codes instead of raw errors", async () => {
      const noticeId = "notice-123";

      (prisma.schemaReplacementNotice.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await service.assessReadiness(noticeId);

      expect(result.status).toBe("not_ready");
      expect(result.reason).toBeDefined();
      expect(
        Object.values(SchemaReplacementReadinessStatusCode).includes(
          result.reason!,
        ),
      ).toBe(true);
    });
  });
});

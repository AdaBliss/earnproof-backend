/**
 * Integration Tests for Schema Replacement Controller (#395)
 * 
 * Tests HTTP endpoint behavior and request/response serialization.
 */

import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, HttpStatus } from "@nestjs/common";
import * as request from "supertest";
import { SchemaReplacementController } from "./schema-replacement.controller";
import { SchemaReplacementService } from "./schema-replacement.service";
import {
  SchemaReplacementStatus,
  SchemaReplacementAcknowledgementStatus,
} from "@prisma/client";

describe("SchemaReplacementController (e2e)", () => {
  let app: INestApplication;
  let service: SchemaReplacementService;

  const mockService = {
    initiateReplacement: jest.fn(),
    getNotice: jest.fn(),
    listNotices: jest.fn(),
    acknowledgeReplacement: jest.fn(),
    listAcknowledgements: jest.fn(),
    assessReadiness: jest.fn(),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [SchemaReplacementController],
      providers: [
        {
          provide: SchemaReplacementService,
          useValue: mockService,
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    service = moduleFixture.get<SchemaReplacementService>(SchemaReplacementService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("POST /schema-replacements", () => {
    it("should initiate a schema replacement notice", async () => {
      const mockNotice = {
        id: "notice-123",
        predecessorSchemaId: "pred-123",
        predecessorSchemaName: "income-v1",
        successorSchemaId: "succ-456",
        successorSchemaName: "income-v2",
        status: SchemaReplacementStatus.PENDING,
        initiatedBy: "actor-789",
        initiatedAt: new Date(),
        deprecationDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        sunsetDeadline: null,
        reason: "Schema update for better performance",
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        totalOrganizations: 0,
        acknowledgedCount: 0,
        pendingCount: 0,
        actedCount: 0,
      };

      mockService.initiateReplacement.mockResolvedValue(mockNotice);

      const response = await request(app.getHttpServer())
        .post("/schema-replacements")
        .set("Authorization", "Bearer test-token")
        .send({
          predecessorSchemaId: "pred-123",
          successorSchemaId: "succ-456",
          deprecationDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          initiatedBy: "actor-789",
          reason: "Schema update for better performance",
        });

      expect(response.status).toBe(HttpStatus.CREATED);
      expect(response.body.id).toBe("notice-123");
      expect(response.body.status).toBe(SchemaReplacementStatus.PENDING);
    });
  });

  describe("GET /schema-replacements/:id", () => {
    it("should retrieve a schema replacement notice", async () => {
      const mockNotice = {
        id: "notice-123",
        predecessorSchemaId: "pred-123",
        predecessorSchemaName: "income-v1",
        successorSchemaId: "succ-456",
        successorSchemaName: "income-v2",
        status: SchemaReplacementStatus.PENDING,
        initiatedBy: "actor-789",
        initiatedAt: new Date(),
        deprecationDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        sunsetDeadline: null,
        reason: null,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        totalOrganizations: 5,
        acknowledgedCount: 3,
        pendingCount: 2,
        actedCount: 2,
      };

      mockService.getNotice.mockResolvedValue(mockNotice);

      const response = await request(app.getHttpServer())
        .get("/schema-replacements/notice-123")
        .set("Authorization", "Bearer test-token");

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.predecessorSchemaName).toBe("income-v1");
      expect(response.body.successorSchemaName).toBe("income-v2");
    });
  });

  describe("GET /schema-replacements", () => {
    it("should list schema replacement notices", async () => {
      const mockNotices = [
        {
          id: "notice-123",
          predecessorSchemaId: "pred-123",
          predecessorSchemaName: "income-v1",
          successorSchemaId: "succ-456",
          successorSchemaName: "income-v2",
          status: SchemaReplacementStatus.PENDING,
          initiatedBy: "actor-789",
          initiatedAt: new Date(),
          deprecationDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          sunsetDeadline: null,
          reason: null,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          totalOrganizations: 0,
          acknowledgedCount: 0,
          pendingCount: 0,
          actedCount: 0,
        },
      ];

      mockService.listNotices.mockResolvedValue(mockNotices);

      const response = await request(app.getHttpServer())
        .get("/schema-replacements")
        .set("Authorization", "Bearer test-token")
        .query({ status: SchemaReplacementStatus.PENDING });

      expect(response.status).toBe(HttpStatus.OK);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBe(1);
    });
  });

  describe("POST /schema-replacements/:id/acknowledge", () => {
    it("should acknowledge a schema replacement notice", async () => {
      const mockAck = {
        id: "ack-001",
        noticeId: "notice-123",
        organizationId: "org-456",
        organizationName: "Test Org",
        acknowledgedBy: "actor-789",
        acknowledgedAt: new Date(),
        status: SchemaReplacementAcknowledgementStatus.ACTED,
        actionTaken: "MIGRATED_PROOFS",
        actionAt: new Date(),
        note: "Successfully migrated all proofs to v2 schema",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockService.acknowledgeReplacement.mockResolvedValue(mockAck);

      const response = await request(app.getHttpServer())
        .post("/schema-replacements/notice-123/acknowledge")
        .set("Authorization", "Bearer test-token")
        .send({
          organizationId: "org-456",
          acknowledgedBy: "actor-789",
          actionTaken: "MIGRATED_PROOFS",
          note: "Successfully migrated all proofs to v2 schema",
        });

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.status).toBe(SchemaReplacementAcknowledgementStatus.ACTED);
      expect(response.body.actionTaken).toBe("MIGRATED_PROOFS");
    });
  });

  describe("GET /schema-replacements/:id/acknowledgements", () => {
    it("should list acknowledgements for a notice", async () => {
      const mockAcks = [
        {
          id: "ack-001",
          noticeId: "notice-123",
          organizationId: "org-456",
          organizationName: "Test Org 1",
          acknowledgedBy: "actor-789",
          acknowledgedAt: new Date(),
          status: SchemaReplacementAcknowledgementStatus.ACTED,
          actionTaken: "MIGRATED_PROOFS",
          actionAt: new Date(),
          note: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "ack-002",
          noticeId: "notice-123",
          organizationId: "org-457",
          organizationName: "Test Org 2",
          acknowledgedBy: "actor-790",
          acknowledgedAt: new Date(),
          status: SchemaReplacementAcknowledgementStatus.PENDING_ACTION,
          actionTaken: null,
          actionAt: null,
          note: "Under review",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockService.listAcknowledgements.mockResolvedValue(mockAcks);

      const response = await request(app.getHttpServer())
        .get("/schema-replacements/notice-123/acknowledgements")
        .set("Authorization", "Bearer test-token");

      expect(response.status).toBe(HttpStatus.OK);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBe(2);
      expect(response.body[0].organizationName).toBe("Test Org 1");
    });
  });

  describe("GET /schema-replacements/:id/readiness", () => {
    it("should assess replacement readiness", async () => {
      const mockReadiness = {
        noticeId: "notice-123",
        status: "ready",
        findings: [],
        overallSeverity: "none",
        stats: {
          totalOrganizations: 5,
          acknowledgedCount: 5,
          actedCount: 3,
          deferredCount: 2,
        },
        assessedAt: new Date(),
        cached: false,
      };

      mockService.assessReadiness.mockResolvedValue(mockReadiness);

      const response = await request(app.getHttpServer())
        .get("/schema-replacements/notice-123/readiness")
        .set("Authorization", "Bearer test-token");

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.status).toBe("ready");
      expect(response.body.overallSeverity).toBe("none");
    });
  });
});

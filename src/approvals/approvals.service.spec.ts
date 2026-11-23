import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { ApprovalRequestStatus } from "@prisma/client";
import { Test, TestingModule } from "@nestjs/testing";
import { canonicalize } from "../common/crypto/canonicalize";
import { sha256 } from "../common/crypto/hash";
import { hashRequestBody } from "../common/crypto/request-body-hash";
import { PrismaService } from "../database/prisma.service";
import { ApprovalsService } from "./approvals.service";

describe("ApprovalsService", () => {
  let service: ApprovalsService;
  let prisma: {
    approvalRequest: {
      create: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
    };
    auditLog: { create: jest.Mock };
  };

  const requester = { id: "user-1", walletAddress: "G1", walletHash: "h1", role: "WORKER" };
  const approver = { id: "user-2", walletAddress: "G2", walletHash: "h2", role: "ADMIN" };

  const payload = { organizationId: "org_1", allowedRegions: ["eu-west-1"] };
  const payloadHash = hashRequestBody(payload).hash;

  function pendingRequest(overrides: Record<string, unknown> = {}) {
    return {
      id: "req-1",
      operationType: "organization.residency_policy.override",
      payload,
      payloadHash,
      payloadHashVersion: 1,
      requestedById: requester.id,
      status: ApprovalRequestStatus.PENDING,
      decidedById: null,
      decidedAt: null,
      decisionReason: null,
      executionLeaseToken: null,
      executionLeasedAt: null,
      executedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApprovalsService,
        {
          provide: PrismaService,
          useValue: {
            approvalRequest: {
              create: jest.fn(),
              findUnique: jest.fn(),
              updateMany: jest.fn(),
            },
            auditLog: { create: jest.fn() },
          },
        },
      ],
    }).compile();

    service = module.get(ApprovalsService);
    prisma = module.get(PrismaService) as unknown as typeof prisma;
  });

  // ---------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------

  describe("create", () => {
    it("pins the payload hash and a default 24h expiry", async () => {
      prisma.approvalRequest.create.mockResolvedValue(pendingRequest());

      await service.create(requester, {
        operationType: "organization.residency_policy.override",
        payload,
      });

      const createArgs = prisma.approvalRequest.create.mock.calls[0][0];
      expect(createArgs.data.payloadHash).toBe(payloadHash);
      expect(createArgs.data.payloadHashVersion).toBe(1);
      expect(createArgs.data.requestedById).toBe(requester.id);
      expect(createArgs.data.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(prisma.auditLog.create).toHaveBeenCalled();
      const auditArgs = prisma.auditLog.create.mock.calls[0][0];
      expect(auditArgs.data.metadata.payloadHash).toBe(payloadHash);
      expect(auditArgs.data.metadata.payloadHashVersion).toBe(1);
      expect(auditArgs.data.metadata.redactedKeys).toEqual([]);
    });

    it("hashes the payload with secret-bearing keys stripped", async () => {
      prisma.approvalRequest.create.mockResolvedValue(pendingRequest());
      const secretPayload = { organizationId: "org_1", apiKey: "sk-live-123" };

      await service.create(requester, {
        operationType: "organization.residency_policy.override",
        payload: secretPayload,
      });

      const createArgs = prisma.approvalRequest.create.mock.calls[0][0];
      // The hash binds only the reviewed, non-secret parameters.
      expect(createArgs.data.payloadHash).toBe(
        hashRequestBody({ organizationId: "org_1" }).hash,
      );
      expect(createArgs.data.payloadHashVersion).toBe(1);
      const auditArgs = prisma.auditLog.create.mock.calls[0][0];
      expect(auditArgs.data.metadata.redactedKeys).toEqual(["apiKey"]);
      // The raw payload is still stored — execution reads it — only the
      // hash input excludes secrets.
      expect(createArgs.data.payload).toEqual(secretPayload);
    });

    it("rejects an oversized payload as a client error", async () => {
      await expect(
        service.create(requester, {
          operationType: "organization.residency_policy.override",
          payload: { blob: "x".repeat(1_048_576) },
        }),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // approve / reject — authorization and terminal-decision guarantees
  // ---------------------------------------------------------------------

  describe("approve", () => {
    it("blocks self-approval", async () => {
      prisma.approvalRequest.findUnique.mockResolvedValue(pendingRequest());

      await expect(
        service.approve(requester, "req-1", { expectedPayloadHash: payloadHash }),
      ).rejects.toThrow(ForbiddenException);

      expect(prisma.approvalRequest.updateMany).not.toHaveBeenCalled();
    });

    it("rejects a stale payload hash before attempting the transition", async () => {
      prisma.approvalRequest.findUnique.mockResolvedValue(pendingRequest());

      await expect(
        service.approve(approver, "req-1", { expectedPayloadHash: "stale-hash" }),
      ).rejects.toThrow(ConflictException);

      expect(prisma.approvalRequest.updateMany).not.toHaveBeenCalled();
    });

    it("fails closed on an unknown stored hash version", async () => {
      prisma.approvalRequest.findUnique.mockResolvedValue(
        pendingRequest({ payloadHashVersion: 99 }),
      );

      await expect(
        service.approve(approver, "req-1", { expectedPayloadHash: payloadHash }),
      ).rejects.toThrow(ConflictException);

      expect(prisma.approvalRequest.updateMany).not.toHaveBeenCalled();
    });

    it("approves a pending request within its deadline", async () => {
      prisma.approvalRequest.findUnique
        .mockResolvedValueOnce(pendingRequest())
        .mockResolvedValueOnce(
          pendingRequest({ status: ApprovalRequestStatus.APPROVED, decidedById: approver.id }),
        );
      prisma.approvalRequest.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.approve(approver, "req-1", {
        expectedPayloadHash: payloadHash,
      });

      expect(result.status).toBe(ApprovalRequestStatus.APPROVED);
      const where = prisma.approvalRequest.updateMany.mock.calls[0][0].where;
      expect(where.status).toBe(ApprovalRequestStatus.PENDING);
    });

    it("gives only one decision when two approvers race on the same request", async () => {
      // First call wins the conditional update; second finds it already terminal.
      // First approver: initial get() sees PENDING, updateMany claims the
      // transition (count 1), final get() reflects the new APPROVED state.
      prisma.approvalRequest.findUnique
        .mockResolvedValueOnce(pendingRequest())
        .mockResolvedValueOnce(pendingRequest({ status: ApprovalRequestStatus.APPROVED }));
      prisma.approvalRequest.updateMany.mockResolvedValueOnce({ count: 1 });

      const first = await service.approve(approver, "req-1", {
        expectedPayloadHash: payloadHash,
      });
      expect(first.status).toBe(ApprovalRequestStatus.APPROVED);

      // Second approver, racing on the same request: initial get() now sees
      // the already-APPROVED row, so its conditional updateMany misses
      // (count 0), and the re-read it uses to explain the conflict confirms
      // the decision is already terminal.
      const other = { id: "user-3", walletAddress: "G3", walletHash: "h3", role: "ADMIN" };
      prisma.approvalRequest.findUnique
        .mockResolvedValueOnce(pendingRequest({ status: ApprovalRequestStatus.APPROVED }))
        .mockResolvedValueOnce(pendingRequest({ status: ApprovalRequestStatus.APPROVED }));
      prisma.approvalRequest.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.reject(other, "req-1", { expectedPayloadHash: payloadHash }),
      ).rejects.toThrow(ConflictException);
    });

    it("rejects a decision on a request that expired exactly at the boundary", async () => {
      prisma.approvalRequest.findUnique.mockResolvedValueOnce(
        pendingRequest({ expiresAt: new Date(Date.now() - 1) }),
      );
      prisma.approvalRequest.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.approvalRequest.findUnique.mockResolvedValueOnce(
        pendingRequest({ expiresAt: new Date(Date.now() - 1) }),
      );

      await expect(
        service.approve(approver, "req-1", { expectedPayloadHash: payloadHash }),
      ).rejects.toThrow("expired");
    });

    it("throws NotFoundException for an unknown request id", async () => {
      prisma.approvalRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.approve(approver, "missing", { expectedPayloadHash: payloadHash }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------
  // cancel
  // ---------------------------------------------------------------------

  describe("cancel", () => {
    it("allows the requester to cancel", async () => {
      prisma.approvalRequest.findUnique
        .mockResolvedValueOnce(pendingRequest())
        .mockResolvedValueOnce(pendingRequest({ status: ApprovalRequestStatus.CANCELLED }));
      prisma.approvalRequest.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.cancel(requester, "req-1");
      expect(result.status).toBe(ApprovalRequestStatus.CANCELLED);
    });

    it("forbids a third party (non-requester, non-admin) from cancelling", async () => {
      const bystander = { id: "user-9", walletAddress: "G9", walletHash: "h9", role: "WORKER" };
      prisma.approvalRequest.findUnique.mockResolvedValue(pendingRequest());

      await expect(service.cancel(bystander, "req-1")).rejects.toThrow(ForbiddenException);
    });

    it("allows an admin who is not the requester to cancel", async () => {
      prisma.approvalRequest.findUnique
        .mockResolvedValueOnce(pendingRequest())
        .mockResolvedValueOnce(pendingRequest({ status: ApprovalRequestStatus.CANCELLED }));
      prisma.approvalRequest.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.cancel(approver, "req-1");
      expect(result.status).toBe(ApprovalRequestStatus.CANCELLED);
    });
  });

  // ---------------------------------------------------------------------
  // execution lease — idempotency under concurrency
  // ---------------------------------------------------------------------

  describe("claimForExecution / completeExecution", () => {
    it("lets only one concurrent caller claim the execution lease", async () => {
      const approved = pendingRequest({ status: ApprovalRequestStatus.APPROVED });
      prisma.approvalRequest.findUnique.mockResolvedValue(approved);
      prisma.approvalRequest.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      const [first, second] = await Promise.all([
        service.claimForExecution("req-1"),
        service.claimForExecution("req-1"),
      ]);

      const claims = [first, second];
      const claimed = claims.filter((c) => c.claimed);
      const notClaimed = claims.filter((c) => !c.claimed);
      expect(claimed).toHaveLength(1);
      expect(notClaimed).toHaveLength(1);
    });

    it("refuses to claim a request that is not APPROVED", async () => {
      prisma.approvalRequest.findUnique.mockResolvedValueOnce(pendingRequest());

      const result = await service.claimForExecution("req-1");
      expect(result.claimed).toBe(false);
      if (!result.claimed) {
        expect(result.request.status).toBe(ApprovalRequestStatus.PENDING);
      }
      expect(prisma.approvalRequest.updateMany).not.toHaveBeenCalled();
    });

    it("refuses to claim when the stored payload no longer matches the approved hash", async () => {
      prisma.approvalRequest.findUnique.mockResolvedValue(
        pendingRequest({
          status: ApprovalRequestStatus.APPROVED,
          payload: { organizationId: "org_2", allowedRegions: ["us-east-1"] },
        }),
      );

      await expect(service.claimForExecution("req-1")).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.approvalRequest.updateMany).not.toHaveBeenCalled();
    });

    it("fails closed on an unknown stored hash version at claim time", async () => {
      prisma.approvalRequest.findUnique.mockResolvedValue(
        pendingRequest({
          status: ApprovalRequestStatus.APPROVED,
          payloadHashVersion: 99,
        }),
      );

      await expect(service.claimForExecution("req-1")).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.approvalRequest.updateMany).not.toHaveBeenCalled();
    });

    it("still claims a pre-redaction row whose legacy unredacted hash matches", async () => {
      // Rows approved before redaction hashed the raw payload. The stored
      // hash here is the legacy form for a payload containing a secret.
      const legacyPayload = { organizationId: "org_1", apiKey: "sk-old" };
      prisma.approvalRequest.findUnique.mockResolvedValue(
        pendingRequest({
          status: ApprovalRequestStatus.APPROVED,
          payload: legacyPayload,
          payloadHash: sha256(canonicalize(legacyPayload)),
        }),
      );
      prisma.approvalRequest.updateMany.mockResolvedValueOnce({ count: 1 });

      const result = await service.claimForExecution("req-1");
      expect(result.claimed).toBe(true);
    });

    it("completes execution exactly once for the winning lease", async () => {
      prisma.approvalRequest.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.approvalRequest.findUnique.mockResolvedValueOnce(
        pendingRequest({
          status: ApprovalRequestStatus.EXECUTED,
          executionLeaseToken: "token-1",
          executedAt: new Date(),
        }),
      );

      const result = await service.completeExecution("req-1", "token-1");
      expect(result.status).toBe(ApprovalRequestStatus.EXECUTED);
      // The execution is recorded in the audit trail with the versioned hash.
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const auditArgs = prisma.auditLog.create.mock.calls[0][0];
      expect(auditArgs.data.action).toBe("approval.executed");
      expect(auditArgs.data.resourceId).toBe("req-1");
      expect(auditArgs.data.metadata.payloadHash).toBe(payloadHash);
      expect(auditArgs.data.metadata.payloadHashVersion).toBe(1);
    });

    it("is idempotent when the same lease completes execution twice", async () => {
      prisma.approvalRequest.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.approvalRequest.findUnique.mockResolvedValueOnce(
        pendingRequest({
          status: ApprovalRequestStatus.EXECUTED,
          executionLeaseToken: "token-1",
          executedAt: new Date(),
        }),
      );

      const result = await service.completeExecution("req-1", "token-1");
      expect(result.status).toBe(ApprovalRequestStatus.EXECUTED);
      // The repeat call records nothing — the first call already did.
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("rejects completion from a caller that does not hold the active lease", async () => {
      prisma.approvalRequest.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.approvalRequest.findUnique.mockResolvedValueOnce(
        pendingRequest({
          status: ApprovalRequestStatus.APPROVED,
          executionLeaseToken: "someone-elses-token",
        }),
      );

      await expect(service.completeExecution("req-1", "my-token")).rejects.toThrow(
        ConflictException,
      );
    });
  });

  // ---------------------------------------------------------------------
  // expireStale
  // ---------------------------------------------------------------------

  describe("expireStale", () => {
    it("returns the number of requests expired", async () => {
      prisma.approvalRequest.updateMany.mockResolvedValue({ count: 3 });
      await expect(service.expireStale()).resolves.toBe(3);
    });
  });
});

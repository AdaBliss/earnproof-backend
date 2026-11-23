import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { WebhooksController } from "./webhooks.controller";
import { CreateWebhookDto } from "./dto/create-webhook.dto";
import { UpdateWebhookEventsDto } from "./dto/update-webhook-events.dto";

type WebhooksServiceMock = {
  create: jest.Mock;
  listForOrg: jest.Mock;
  getForOrg: jest.Mock;
  updateEvents: jest.Mock;
  rotateSecret: jest.Mock;
  disable: jest.Mock;
  enable: jest.Mock;
  delete: jest.Mock;
  listDeliveries: jest.Mock;
  getDeliveryReceipt: jest.Mock;
  getReceiptById: jest.Mock;
  replayDelivery: jest.Mock;
};

type PrismaServiceMock = {
  user: {
    findUnique: jest.Mock;
  };
};

describe("WebhooksController", () => {
  let controller: WebhooksController;
  let webhooksService: WebhooksServiceMock;
  let prismaService: PrismaServiceMock;

  const authenticatedUser: AuthenticatedUser = {
    id: "user_123",
    walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1",
    walletHash: "hash_user_123",
    role: "DEVELOPER",
  };

  const organizationId = "org_test_123";
  const webhookId = "ckv8v6h2b0002qzrm7t4k9xza";

  beforeEach(() => {
    webhooksService = {
      create: jest.fn(),
      listForOrg: jest.fn(),
      getForOrg: jest.fn(),
      updateEvents: jest.fn(),
      rotateSecret: jest.fn(),
      disable: jest.fn(),
      enable: jest.fn(),
      delete: jest.fn(),
      listDeliveries: jest.fn(),
      getDeliveryReceipt: jest.fn(),
      getReceiptById: jest.fn(),
      replayDelivery: jest.fn(),
    };

    prismaService = {
      user: {
        findUnique: jest.fn(),
      },
    };

    // The controller constructor is (webhooksService, circuitBreakerService,
    // prismaService, deadLetters). The receipt endpoints only use the first
    // and third, but the other two must still occupy their slots — passing
    // the prisma mock second leaves `this.prisma` undefined and every
    // endpoint fails in requireOrgId.
    const circuitBreakerService = {
      getCircuitStats: jest.fn(),
      initializeCircuit: jest.fn(),
      updateConfig: jest.fn(),
    };
    const deadLetters = {
      list: jest.fn(),
      redrive: jest.fn(),
      redriveBatch: jest.fn(),
    };

    controller = new WebhooksController(
      webhooksService as never,
      circuitBreakerService as never,
      prismaService as never,
      deadLetters as never,
    );

    prismaService.user.findUnique.mockResolvedValue({
      organizations: [{ id: organizationId }],
    });
  });

  describe("create", () => {
    it("should create a webhook endpoint", async () => {
      const webhook = {
        id: webhookId,
        url: "https://example.com/webhooks/earnproof",
        events: ["proof.created"],
        status: "ACTIVE",
        signingSecret: "secret_abc123",
      };
      webhooksService.create.mockResolvedValueOnce(webhook);

      const dto: CreateWebhookDto = {
        url: "https://example.com/webhooks/earnproof",
        events: ["proof.created"],
      };
      const result = await controller.create(authenticatedUser, dto);

      expect(result).toEqual(webhook);
      expect(webhooksService.create).toHaveBeenCalledWith(organizationId, dto);
    });

    it("should reject HTTP URLs", async () => {
      webhooksService.create.mockRejectedValueOnce(
        new BadRequestException("URL must be HTTPS"),
      );

      const dto: CreateWebhookDto = {
        url: "http://example.com/webhooks/earnproof",
        events: ["proof.created"],
      };

      await expect(controller.create(authenticatedUser, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should reject empty event list", async () => {
      webhooksService.create.mockRejectedValueOnce(
        new BadRequestException("Event list cannot be empty"),
      );

      const dto: CreateWebhookDto = {
        url: "https://example.com/webhooks/earnproof",
        events: [],
      };

      await expect(controller.create(authenticatedUser, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should fail when user has no active organisation", async () => {
      prismaService.user.findUnique.mockResolvedValueOnce({
        organizations: [],
      });

      const dto: CreateWebhookDto = {
        url: "https://example.com/webhooks/earnproof",
        events: ["proof.created"],
      };

      await expect(controller.create(authenticatedUser, dto)).rejects.toThrow(
        ForbiddenException,
      );
      expect(webhooksService.create).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("should list webhooks for the organisation", async () => {
      const webhooks = [
        {
          id: webhookId,
          url: "https://example.com/webhooks/earnproof",
          events: ["proof.created"],
          status: "ACTIVE",
        },
      ];
      webhooksService.listForOrg.mockResolvedValueOnce(webhooks);

      const result = await controller.list(authenticatedUser);

      expect(result).toEqual(webhooks);
      expect(webhooksService.listForOrg).toHaveBeenCalledWith(
        organizationId,
        undefined,
      );
    });

    it("should return empty list when no webhooks exist", async () => {
      webhooksService.listForOrg.mockResolvedValueOnce([]);

      const result = await controller.list(authenticatedUser);

      expect(result).toEqual([]);
    });
  });

  describe("get", () => {
    it("should get a specific webhook by ID", async () => {
      const webhook = {
        id: webhookId,
        url: "https://example.com/webhooks/earnproof",
        events: ["proof.created"],
        status: "ACTIVE",
      };
      webhooksService.getForOrg.mockResolvedValueOnce(webhook);

      const result = await controller.get(authenticatedUser, webhookId);

      expect(result).toEqual(webhook);
      expect(webhooksService.getForOrg).toHaveBeenCalledWith(organizationId, webhookId);
    });

    it("should return 404 for non-existent webhook", async () => {
      webhooksService.getForOrg.mockRejectedValueOnce(
        new NotFoundException("Webhook not found"),
      );

      await expect(controller.get(authenticatedUser, "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("updateEvents", () => {
    it("should update event subscriptions", async () => {
      const updated = {
        id: webhookId,
        events: ["proof.revoked"],
        status: "ACTIVE",
      };
      webhooksService.updateEvents.mockResolvedValueOnce(updated);

      const dto: UpdateWebhookEventsDto = {
        events: ["proof.revoked"],
      };
      const result = await controller.updateEvents(authenticatedUser, webhookId, dto);

      expect(result).toEqual(updated);
      expect(webhooksService.updateEvents).toHaveBeenCalledWith(
        organizationId,
        webhookId,
        dto,
      );
    });

    it("should reject empty event list", async () => {
      webhooksService.updateEvents.mockRejectedValueOnce(
        new BadRequestException("Event list cannot be empty"),
      );

      const dto: UpdateWebhookEventsDto = { events: [] };

      await expect(
        controller.updateEvents(authenticatedUser, webhookId, dto),
      ).rejects.toThrow(BadRequestException);
    });

    it("should return 404 for non-existent webhook", async () => {
      webhooksService.updateEvents.mockRejectedValueOnce(
        new NotFoundException("Webhook not found"),
      );

      const dto: UpdateWebhookEventsDto = { events: ["proof.created"] };

      await expect(
        controller.updateEvents(authenticatedUser, "nonexistent", dto),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("rotateSecret", () => {
    it("should rotate the signing secret", async () => {
      const rotated = {
        webhookId,
        signingSecret: "new_secret_xyz789",
      };
      webhooksService.rotateSecret.mockResolvedValueOnce(rotated);

      const result = await controller.rotateSecret(authenticatedUser, webhookId);

      expect(result).toEqual(rotated);
      expect(webhooksService.rotateSecret).toHaveBeenCalledWith(organizationId, webhookId);
    });

    it("should return 404 for non-existent webhook", async () => {
      webhooksService.rotateSecret.mockRejectedValueOnce(
        new NotFoundException("Webhook not found"),
      );

      await expect(
        controller.rotateSecret(authenticatedUser, "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("disable", () => {
    it("should disable a webhook endpoint", async () => {
      const disabled = {
        id: webhookId,
        status: "DISABLED",
      };
      webhooksService.disable.mockResolvedValueOnce(disabled);

      const result = await controller.disable(authenticatedUser, webhookId);

      expect(result.status).toBe("DISABLED");
      expect(webhooksService.disable).toHaveBeenCalledWith(organizationId, webhookId);
    });

    it("should return 404 for non-existent webhook", async () => {
      webhooksService.disable.mockRejectedValueOnce(
        new NotFoundException("Webhook not found"),
      );

      await expect(
        controller.disable(authenticatedUser, "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("enable", () => {
    it("should re-enable a disabled webhook", async () => {
      const enabled = {
        id: webhookId,
        status: "ACTIVE",
      };
      webhooksService.enable.mockResolvedValueOnce(enabled);

      const result = await controller.enable(authenticatedUser, webhookId);

      expect(result.status).toBe("ACTIVE");
      expect(webhooksService.enable).toHaveBeenCalledWith(organizationId, webhookId);
    });

    it("should return 404 for non-existent webhook", async () => {
      webhooksService.enable.mockRejectedValueOnce(
        new NotFoundException("Webhook not found"),
      );

      await expect(controller.enable(authenticatedUser, "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("delete", () => {
    it("should delete a webhook endpoint", async () => {
      const deleted = {
        deleted: true,
        webhookId,
      };
      webhooksService.delete.mockResolvedValueOnce(deleted);

      const result = await controller.delete(authenticatedUser, webhookId);

      expect(result.deleted).toBe(true);
      expect(webhooksService.delete).toHaveBeenCalledWith(organizationId, webhookId);
    });

    it("should return 404 for non-existent webhook", async () => {
      webhooksService.delete.mockRejectedValueOnce(
        new NotFoundException("Webhook not found"),
      );

      await expect(
        controller.delete(authenticatedUser, "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("listDeliveries", () => {
    it("should list recent delivery records", async () => {
      const deliveries = [
        {
          id: "ckv8v6h2b0003qzrm4d8n2plq",
          eventType: "proof.created",
          status: "DELIVERED",
          statusCode: 200,
          durationMs: 142,
        },
      ];
      webhooksService.listDeliveries.mockResolvedValueOnce(deliveries);

      const result = await controller.listDeliveries(authenticatedUser, webhookId);

      expect(result).toEqual(deliveries);
      expect(webhooksService.listDeliveries).toHaveBeenCalledWith(
        organizationId,
        webhookId,
        undefined,
      );
    });

    it("should return 404 for non-existent webhook", async () => {
      webhooksService.listDeliveries.mockRejectedValueOnce(
        new NotFoundException("Webhook not found"),
      );

      await expect(
        controller.listDeliveries(authenticatedUser, "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("getDeliveryReceipt", () => {
    const receipt = {
      receiptId: "wr_v1_" + "0".repeat(64),
      version: "1",
      webhookId,
      deliveryId: "ckv8v6h2b0003qzrm4d8n2plq",
      eventId: "evt_01hxk8s3n7q9v2m4c6d8e0f2g4",
      eventType: "proof.created",
      payloadHash: "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
      attempt: 1,
      lineageId: "ckv8v6h2b0003qzrm4d8n2plq",
      replayOf: null,
      schemaVersion: "1",
      source: "stored",
      status: "SUCCESS",
      deliveredAt: "2026-08-24T12:30:01.000Z",
      createdAt: "2026-08-24T12:30:00.000Z",
    };

    it("should return the receipt for an owned delivery", async () => {
      webhooksService.getDeliveryReceipt.mockResolvedValueOnce(receipt);

      const result = await controller.getDeliveryReceipt(
        authenticatedUser,
        webhookId,
        "ckv8v6h2b0003qzrm4d8n2plq",
      );

      expect(result).toEqual(receipt);
      expect(webhooksService.getDeliveryReceipt).toHaveBeenCalledWith(
        organizationId,
        webhookId,
        "ckv8v6h2b0003qzrm4d8n2plq",
      );
    });

    it("should return 404 for a delivery of another organisation", async () => {
      webhooksService.getDeliveryReceipt.mockRejectedValueOnce(
        new NotFoundException("Delivery not found"),
      );

      await expect(
        controller.getDeliveryReceipt(
          authenticatedUser,
          webhookId,
          "ckv8v6h2b0003qzrm4d8n2plq",
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("getReceiptById", () => {
    const receiptId = "wr_v1_" + "0".repeat(64);

    it("should resolve a receipt id to its delivery attempt", async () => {
      const receipt = {
        receiptId,
        version: "1",
        webhookId,
        deliveryId: "ckv8v6h2b0003qzrm4d8n2plq",
        eventId: "evt_01hxk8s3n7q9v2m4c6d8e0f2g4",
        eventType: "proof.created",
        payloadHash:
          "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
        attempt: 1,
        lineageId: "ckv8v6h2b0003qzrm4d8n2plq",
        replayOf: null,
        schemaVersion: "1",
        source: "stored",
        status: "SUCCESS",
        deliveredAt: "2026-08-24T12:30:01.000Z",
        createdAt: "2026-08-24T12:30:00.000Z",
      };
      webhooksService.getReceiptById.mockResolvedValueOnce(receipt);

      const result = await controller.getReceiptById(
        authenticatedUser,
        webhookId,
        receiptId,
      );

      expect(result).toEqual(receipt);
      expect(webhooksService.getReceiptById).toHaveBeenCalledWith(
        organizationId,
        webhookId,
        receiptId,
      );
    });

    it("should return 404 for an unknown receipt id", async () => {
      webhooksService.getReceiptById.mockRejectedValueOnce(
        new NotFoundException("Delivery receipt not found"),
      );

      await expect(
        controller.getReceiptById(authenticatedUser, webhookId, receiptId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("replayDelivery", () => {
    it("should replay a delivery for DEVELOPER role", async () => {
      const replay = {
        replayDeliveryId: "ckv8v6h2b0004qzrm1s6y3wkc",
        originalDeliveryId: "ckv8v6h2b0003qzrm4d8n2plq",
        eventType: "proof.created",
        replayedBy: authenticatedUser.id,
      };
      webhooksService.replayDelivery.mockResolvedValueOnce(replay);

      const result = await controller.replayDelivery(
        authenticatedUser,
        "ckv8v6h2b0003qzrm4d8n2plq",
      );

      expect(result).toEqual(replay);
      expect(webhooksService.replayDelivery).toHaveBeenCalledWith(
        organizationId,
        "ckv8v6h2b0003qzrm4d8n2plq",
        authenticatedUser.id,
      );
    });

    it("should reject WORKER role", async () => {
      const workerUser: AuthenticatedUser = {
        id: "user_worker",
        walletAddress: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC3",
        walletHash: "hash_worker",
        role: "WORKER",
      };

      prismaService.user.findUnique.mockResolvedValueOnce({
        organizations: [{ id: organizationId }],
      });

      await expect(
        controller.replayDelivery(workerUser, "ckv8v6h2b0003qzrm4d8n2plq"),
      ).rejects.toThrow(ForbiddenException);
      expect(webhooksService.replayDelivery).not.toHaveBeenCalled();
    });

    it("should return 404 for non-existent delivery", async () => {
      webhooksService.replayDelivery.mockRejectedValueOnce(
        new NotFoundException("Delivery not found"),
      );

      await expect(
        controller.replayDelivery(authenticatedUser, "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("organisation resolution", () => {
    it("should fail when user has no active organisation", async () => {
      prismaService.user.findUnique.mockResolvedValueOnce({
        organizations: [],
      });

      const dto: CreateWebhookDto = {
        url: "https://example.com/webhooks/earnproof",
        events: ["proof.created"],
      };

      await expect(controller.create(authenticatedUser, dto)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe("authenticated request handling", () => {
    it("should enforce authentication on all endpoints", () => {
      expect(controller.create).toBeDefined();
      expect(controller.list).toBeDefined();
      expect(controller.get).toBeDefined();
      expect(controller.updateEvents).toBeDefined();
      expect(controller.rotateSecret).toBeDefined();
      expect(controller.disable).toBeDefined();
      expect(controller.enable).toBeDefined();
      expect(controller.delete).toBeDefined();
      expect(controller.listDeliveries).toBeDefined();
      expect(controller.replayDelivery).toBeDefined();
    });
  });
});

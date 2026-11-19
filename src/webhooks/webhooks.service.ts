import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ResourceStatus } from "@prisma/client";
import { randomBytes } from "crypto";
import { PaymentEncryptionKeyringService } from "../common/crypto/payment-encryption-keyring.service";
import { PrismaService } from "../database/prisma.service";
import {
  buildPage,
  cursorOrderBy,
  cursorWhereFragment,
} from "../common/pagination/keyset-paginate";
import { ConflictException } from "../common/exceptions/domain.exceptions";
import { CreateWebhookDto } from "./dto/create-webhook.dto";
import { UpdateWebhookEventsDto } from "./dto/update-webhook-events.dto";
import { UpdateWebhookUrlDto } from "./dto/update-webhook-url.dto";
import { VerifyWebhookDto } from "./dto/verify-webhook.dto";
import { OrganizationQuotaService } from "../quotas/organization-quota.service";
import { WebhookDeliveryService } from "./webhook-delivery.service";
import {
  buildDeliveryReceipt,
  isValidReceiptId,
  type WebhookDeliveryReceiptData,
} from "./webhook-delivery-receipt";
import { WebhookCircuitBreakerService } from "./webhook-circuit-breaker.service";
import { WebhookVerificationService } from "./webhook-verification.service";
import { PredicatePreviewService } from "./services/predicate-preview.service";
import { CURRENT_WEBHOOK_PAYLOAD_VERSION } from "./webhook-event.types";
import { SecretRetrievalReceiptService } from "../audit/secret-retrieval-receipt.service";
import { SecretType, DeliveryChannel } from "../audit/types/secret-retrieval-receipt.types";

/** Signing secret length in bytes (produces a 64-char hex string). */
const SECRET_BYTES = 32;

/**
 * A delivery idempotency receipt as returned by the API.
 *
 * The receipt identifies one delivery attempt; it carries no signing secret
 * and no payload content (only its SHA-256), so it cannot authorize a
 * replay or reveal another tenant's event. `source` says whether the
 * receipt was read from its stored row (`stored`) or re-derived from the
 * delivery row (`computed`, for deliveries created before receipts existed
 * or whose stored write was missed — the id is identical either way).
 * `status`/`deliveredAt` are the delivery's outcome at read time; the
 * receipt itself is immutable.
 */
export interface WebhookDeliveryReceiptView
  extends Omit<WebhookDeliveryReceiptData, "version"> {
  /** Receipt scheme version as stored (plain string from the database). */
  version: string;
  source: "stored" | "computed";
  status: string;
  deliveredAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class WebhooksService {
  private readonly paymentEncryptionKeyring: PaymentEncryptionKeyringService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveryService: WebhookDeliveryService,
    private readonly circuitBreaker: WebhookCircuitBreakerService,
    private readonly verificationService: WebhookVerificationService,
    configService: ConfigService,
    private readonly quotas: OrganizationQuotaService,
    @Optional() private readonly secretRetrievalReceiptService?: SecretRetrievalReceiptService,
    @Optional() private readonly predicatePreviewService?: PredicatePreviewService,
  ) {
    this.paymentEncryptionKeyring = new PaymentEncryptionKeyringService(
      configService,
    );
  }

  /**
   * Create a webhook endpoint for the given organisation.
   *
   * The endpoint starts `PENDING`: no real event deliveries go out until the
   * destination's ownership is verified (see `verify`). A verification
   * challenge is issued and sent immediately.
   *
   * Returns the raw signing secret ONCE — it is never retrievable again.
   * The caller must store it securely.
   */
  async create(organizationId: string, dto: CreateWebhookDto) {
    const rawSecret = randomBytes(SECRET_BYTES).toString("hex");
    const secretEncrypted = this.paymentEncryptionKeyring.encrypt(rawSecret);

    // De-duplicate events list
    const events = [...new Set(dto.events)];

    // Quota check, creation, receipt, and circuit breaker initialization together
    const webhook = await this.prisma.$transaction(async (tx) => {
      await this.quotas.assertCapacity(tx, organizationId, "webhooks");

      const created = await tx.webhook.create({
        data: {
          organizationId,
          url: dto.url,
          secretEncrypted,
          events,
          payloadVersion: dto.payloadVersion ?? CURRENT_WEBHOOK_PAYLOAD_VERSION,
          status: ResourceStatus.PENDING,
          revision: 0,
        },
        select: {
          id: true,
          url: true,
          events: true,
          payloadVersion: true,
          status: true,
          revision: true,
          createdAt: true,
        },
      });

      let receiptId: string | undefined;
      if (this.secretRetrievalReceiptService) {
        const receipt = await this.secretRetrievalReceiptService.create(
          {
            organizationId,
            secretType: SecretType.WEBHOOK,
            resourceId: created.id,
            resourceReference: dto.url,
            recipientId: undefined, // webhook creation typically not attributed to a user
            deliveryChannel: DeliveryChannel.HTTP_RESPONSE,
            revealedAt: new Date(),
          },
          tx,
        );
        receiptId = receipt.id;
      }

      // Audit log: webhook created
      await tx.auditLog.create({
        data: {
          actorType: "user",
          action: "webhook.created",
          resourceType: "webhook",
          resourceId: created.id,
          organizationId,
          metadata: {
            url: dto.url,
            events,
            receiptId,
          },
        },
      });

      return created;
    });

    // Initialize circuit breaker for new webhook (outside transaction for idempotency)
    await this.circuitBreaker.initializeCircuit(webhook.id);

    await this.verificationService.issueChallenge(webhook.id, dto.url, rawSecret);

    return {
      ...webhook,
      // Returned once at creation time only.
      signingSecret: rawSecret,
    };
  }

  /** List webhook endpoints for an organisation, newest first. */
  async listForOrg(
    organizationId: string,
    pagination: { cursor?: string; limit?: number } = {},
  ) {
    const limit = pagination.limit ?? 20;
    const cursorWhere = cursorWhereFragment(pagination.cursor, "createdAt");

    const rows = await this.prisma.webhook.findMany({
      where: { organizationId, ...cursorWhere },
      orderBy: cursorOrderBy("createdAt"),
      take: limit + 1,
      select: {
        id: true,
        url: true,
        events: true,
        payloadVersion: true,
        status: true,
        revision: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return buildPage(rows, limit, "createdAt");
  }

  /** Get a single webhook, asserting ownership. */
  async getForOrg(organizationId: string, webhookId: string) {
    const webhook = await this.prisma.webhook.findUnique({
      where: { id: webhookId },
      select: {
        id: true,
        organizationId: true,
        url: true,
        events: true,
        payloadVersion: true,
        status: true,
        revision: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    this.assertOwnership(webhook, organizationId, webhookId);
    return webhook!;
  }

  /**
   * Rotate the webhook signing secret.
   *
   * Moves the current ACTIVE secret to OVERLAP state (with a bounded overlap window)
   * and creates a new ACTIVE secret. This allows retries and replays to use the previous
   * key for a limited time.
   *
   * Returns the new raw secret and keyId once.
   */
  async rotateSecret(organizationId: string, webhookId: string) {
    const webhook = await this.assertOwnedWebhookFull(organizationId, webhookId);

    const newRawSecret = randomBytes(SECRET_BYTES).toString("hex");
    const newSecretEncrypted = this.paymentEncryptionKeyring.encrypt(newRawSecret);

    const updateData = {
      secretEncrypted: newSecretEncrypted,
      revision: webhook.revision + 1,
    };

    if (typeof this.prisma.$transaction === "function") {
      await this.prisma.$transaction(async (tx) => {
        await tx.webhook.update({
          where: { id: webhookId },
          data: updateData,
        });

        if (this.secretRetrievalReceiptService) {
          const receipt = await this.secretRetrievalReceiptService.create(
            {
              organizationId,
              secretType: SecretType.WEBHOOK,
              resourceId: webhookId,
              resourceReference: webhook.url,
              recipientId: undefined,
              deliveryChannel: DeliveryChannel.HTTP_RESPONSE,
              revealedAt: new Date(),
            },
            tx,
          );

          await tx.auditLog.create({
            data: {
              actorType: "user",
              action: "webhook.rotated",
              resourceType: "webhook",
              resourceId: webhookId,
              organizationId,
              metadata: {
                url: webhook.url,
                receiptId: receipt.id,
              },
            },
          });
        }
      });
    } else {
      await this.prisma.webhook.update({
        where: { id: webhookId },
        data: updateData,
      });
    }

    return {
      webhookId,
      signingSecret: newRawSecret,
      rotatedAt: new Date().toISOString(),
      note: "Any in-flight deliveries signed with the old secret will fail their current attempt. They will be retried with the new secret.",
    };
  }

  /**
   * Change a webhook's destination URL.
   *
   * The endpoint reverts to `PENDING` and a fresh verification challenge is
   * issued for the new destination — any verification of the previous URL
   * no longer authorises deliveries, since a destination change always
   * requires re-proving control of the new one.
   */
  async updateUrl(
    organizationId: string,
    webhookId: string,
    dto: UpdateWebhookUrlDto,
  ) {
    const webhook = await this.assertOwnedWebhookFull(organizationId, webhookId);

    const updated = await this.prisma.webhook.update({
      where: { id: webhookId },
      data: {
        url: dto.url,
        status: ResourceStatus.PENDING,
        revision: webhook.revision + 1,
      },
      select: {
        id: true,
        url: true,
        events: true,
        status: true,
        revision: true,
        updatedAt: true,
      },
    });

    const signingSecret = this.paymentEncryptionKeyring.decrypt(
      webhook.secretEncrypted,
    );
    await this.verificationService.issueChallenge(webhookId, dto.url, signingSecret);

    return updated;
  }

  /**
   * Re-send a verification challenge for a webhook that has not yet been
   * verified (e.g. the previous challenge expired or was never delivered).
   */
  async resendVerification(organizationId: string, webhookId: string) {
    const webhook = await this.assertOwnedWebhookFull(organizationId, webhookId);

    if (webhook.status !== ResourceStatus.PENDING) {
      throw new BadRequestException(
        "Only a webhook awaiting verification can have its challenge re-sent",
      );
    }

    const signingSecret = this.paymentEncryptionKeyring.decrypt(
      webhook.secretEncrypted,
    );
    const { expiresAt } = await this.verificationService.issueChallenge(
      webhookId,
      webhook.url,
      signingSecret,
    );

    return { webhookId, status: webhook.status, expiresAt };
  }

  /**
   * Acknowledge a verification challenge. On success the webhook becomes
   * `ACTIVE` and real event deliveries begin.
   */
  async verify(
    organizationId: string,
    webhookId: string,
    dto: VerifyWebhookDto,
  ) {
    const existing = await this.assertOwnedWebhook(organizationId, webhookId);

    await this.verificationService.verifyChallenge(webhookId, dto.token);

    const webhook = await this.prisma.webhook.update({
      where: { id: webhookId },
      data: {
        status: ResourceStatus.ACTIVE,
        revision: existing.revision + 1,
      },
      select: { id: true, status: true, revision: true, updatedAt: true },
    });

    return webhook;
  }

  /** Update subscribed event types. */
  async updateEvents(
    organizationId: string,
    webhookId: string,
    dto: UpdateWebhookEventsDto,
  ) {
    const webhook = await this.assertOwnedWebhook(organizationId, webhookId);
    const events = [...new Set(dto.events)];

    // Attempt optimistic update with revision check
    const updated = await this.prisma.webhook.updateMany({
      where: {
        id: webhookId,
        revision: dto.expectedRevision,
      },
      data: {
        events,
        revision: dto.expectedRevision + 1,
      },
    });

    // If no records were updated, the revision didn't match
    if (updated.count === 0) {
      throw new ConflictException(
        "Webhook has been modified by another request. Please refresh and retry.",
        webhook.revision,
      );
    }

    return this.prisma.webhook.findUnique({
      where: { id: webhookId },
      select: { id: true, url: true, events: true, status: true, revision: true, updatedAt: true },
    });
  }

  /** Disable (suspend) a webhook endpoint without deleting it. */
  async disable(organizationId: string, webhookId: string) {
    const webhook = await this.assertOwnedWebhook(organizationId, webhookId);

    return this.prisma.webhook.update({
      where: { id: webhookId },
      data: {
        status: ResourceStatus.SUSPENDED,
        revision: webhook.revision + 1,
      },
      select: { id: true, status: true, revision: true, updatedAt: true },
    });
  }

  /** Re-enable a previously disabled webhook endpoint. */
  async enable(organizationId: string, webhookId: string) {
    const webhook = await this.assertOwnedWebhook(organizationId, webhookId);

    return this.prisma.webhook.update({
      where: { id: webhookId },
      data: {
        status: ResourceStatus.ACTIVE,
        revision: webhook.revision + 1,
      },
      select: { id: true, status: true, revision: true, updatedAt: true },
    });
  }

  /** Soft-delete (mark DELETED) a webhook endpoint. */
  async delete(organizationId: string, webhookId: string) {
    const webhook = await this.assertOwnedWebhook(organizationId, webhookId);

    await this.prisma.webhook.update({
      where: { id: webhookId },
      data: {
        status: ResourceStatus.DELETED,
        revision: webhook.revision + 1,
      },
    });

    // Clean up circuit breaker state
    await this.circuitBreaker.deleteCircuitState(webhookId);

    return { deleted: true, webhookId };
  }

  /**
   * Replay a specific delivery.
   *
   * Authorization (DEVELOPER or ADMIN role) is enforced in the controller.
   * The caller must also own the webhook org.
   */
  async replayDelivery(
    organizationId: string,
    deliveryId: string,
    replayedById: string,
  ) {
    // Verify the delivery belongs to one of this org's webhooks.
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: {
        webhook: { select: { organizationId: true } },
      },
    });

    if (!delivery) {
      throw new NotFoundException("Delivery not found");
    }

    if (delivery.webhook.organizationId !== organizationId) {
      throw new ForbiddenException("Delivery does not belong to this organisation");
    }

    // Persist audit record before dispatching.
    await this.prisma.auditLog.create({
      data: {
        actorType: "user",
        actorId: replayedById,
        action: "webhook.delivery.replayed",
        resourceType: "webhookDelivery",
        resourceId: deliveryId,
        metadata: {
          webhookId: delivery.webhookId,
          eventType: delivery.eventType,
          eventId: delivery.eventId,
          originalAttempt: delivery.attempt,
        },
      },
    });

    const newDeliveryId = await this.deliveryService.replay(deliveryId, replayedById);

    return {
      replayDeliveryId: newDeliveryId,
      originalDeliveryId: deliveryId,
      eventId: delivery.eventId,
      eventType: delivery.eventType,
      replayedBy: replayedById,
      replayedAt: new Date().toISOString(),
    };
  }

  /**
   * Send a synthetic, signed `webhook.test` event to an endpoint and return
   * redacted delivery diagnostics.
   *
   * Role authorization (DEVELOPER or ADMIN) is enforced in the controller; this
   * asserts the endpoint belongs to the caller's organisation and is active,
   * the same preconditions a replay has. Nothing is persisted: see
   * `WebhookDeliveryService.sendTestDelivery`.
   */
  async sendTestDelivery(organizationId: string, webhookId: string) {
    const webhook = await this.prisma.webhook.findUnique({
      where: { id: webhookId },
      select: {
        id: true,
        organizationId: true,
        url: true,
        secretEncrypted: true,
        status: true,
      },
    });

    this.assertOwnership(webhook, organizationId, webhookId);

    if (webhook!.status !== ResourceStatus.ACTIVE) {
      throw new BadRequestException(
        "Cannot send a test delivery to a disabled webhook endpoint",
      );
    }

    return this.deliveryService.sendTestDelivery(webhook!);
  }

  /**
   * List delivery records for a webhook endpoint.
   * Response body and sensitive headers are never stored in delivery rows,
   * so this is safe to return directly.
   *
   * Each row also carries its versioned idempotency `receiptId`, computed
   * from the stored row (the same id sent as `X-EarnProof-Receipt` on the
   * attempt). `payloadBody` is read only to hash it and is never returned.
   */
  async listDeliveries(
    organizationId: string,
    webhookId: string,
    pagination: { cursor?: string; limit?: number } = {},
  ) {
    await this.assertOwnedWebhook(organizationId, webhookId);

    const limit = pagination.limit ?? 20;
    const cursorWhere = cursorWhereFragment(pagination.cursor, "createdAt");

    const rows = await this.prisma.webhookDelivery.findMany({
      where: { webhookId, ...cursorWhere },
      orderBy: cursorOrderBy("createdAt"),
      take: limit + 1,
      select: {
        id: true,
        eventType: true,
        eventId: true,
        schemaVersion: true,
        payloadBody: true,
        attempt: true,
        lineageId: true,
        replayOf: true,
        status: true,
        statusCode: true,
        // responseBody stored truncated — safe to return
        responseBody: true,
        durationMs: true,
        failureReason: true,
        replayedBy: true,
        deliveredAt: true,
        nextRetryAt: true,
        deadLetteredAt: true,
        deadLetterReason: true,
        redrivenAt: true,
        createdAt: true,
      },
    });

    const withReceipts = rows.map(
      ({ payloadBody, lineageId, ...row }) => ({
        ...row,
        receiptId: buildDeliveryReceipt({
          deliveryId: row.id,
          webhookId,
          eventId: row.eventId,
          eventType: row.eventType,
          payloadBody,
          schemaVersion: row.schemaVersion,
          attempt: row.attempt,
          lineageId: lineageId ?? row.id,
          replayOf: row.replayOf ?? null,
        }).receiptId,
      }),
    );

    return buildPage(withReceipts, limit, "createdAt");
  }

  /**
   * The idempotency receipt for one delivery attempt.
   *
   * Scoped to the caller's organisation through the webhook: a delivery
   * belonging to another organisation is reported as not found, never as
   * forbidden, so its existence is not disclosed. Prefers the stored
   * receipt row; falls back to re-deriving the receipt from the delivery
   * row, which yields the identical id for deliveries created before
   * receipts existed.
   */
  async getDeliveryReceipt(
    organizationId: string,
    webhookId: string,
    deliveryId: string,
  ): Promise<WebhookDeliveryReceiptView> {
    await this.assertOwnedWebhook(organizationId, webhookId);

    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      select: {
        id: true,
        webhookId: true,
        eventId: true,
        eventType: true,
        payloadBody: true,
        schemaVersion: true,
        attempt: true,
        lineageId: true,
        replayOf: true,
        status: true,
        deliveredAt: true,
        createdAt: true,
      },
    });

    if (!delivery || delivery.webhookId !== webhookId) {
      throw new NotFoundException("Delivery not found");
    }

    const stored = await this.prisma.webhookDeliveryReceipt.findUnique({
      where: { deliveryId },
      select: {
        receiptId: true,
        version: true,
        webhookId: true,
        deliveryId: true,
        eventId: true,
        eventType: true,
        payloadHash: true,
        attempt: true,
        lineageId: true,
        replayOf: true,
        schemaVersion: true,
        createdAt: true,
      },
    });

    if (stored) {
      return {
        ...stored,
        source: "stored",
        status: delivery.status,
        deliveredAt: delivery.deliveredAt,
      };
    }

    return {
      ...buildDeliveryReceipt({
        deliveryId: delivery.id,
        webhookId: delivery.webhookId,
        eventId: delivery.eventId,
        eventType: delivery.eventType,
        payloadBody: delivery.payloadBody,
        schemaVersion: delivery.schemaVersion,
        attempt: delivery.attempt,
        lineageId: delivery.lineageId ?? delivery.id,
        replayOf: delivery.replayOf ?? null,
      }),
      source: "computed",
      status: delivery.status,
      deliveredAt: delivery.deliveredAt,
      createdAt: delivery.createdAt,
    };
  }

  /**
   * Resolve a consumer-presented receipt id to its delivery attempt.
   *
   * Scoped to one webhook of the caller's organisation: a receipt naming
   * another endpoint (or another tenant) is reported as not found, never
   * as forbidden, so its existence is not disclosed. Only stored receipts
   * resolve here — a receipt id is a one-way hash, so a delivery with no
   * stored receipt cannot be found by id alone; use the per-delivery
   * endpoint for those.
   */
  async getReceiptById(
    organizationId: string,
    webhookId: string,
    receiptId: string,
  ): Promise<WebhookDeliveryReceiptView> {
    await this.assertOwnedWebhook(organizationId, webhookId);

    if (!isValidReceiptId(receiptId)) {
      throw new NotFoundException("Delivery receipt not found");
    }

    const stored = await this.prisma.webhookDeliveryReceipt.findUnique({
      where: { receiptId },
      select: {
        receiptId: true,
        version: true,
        webhookId: true,
        deliveryId: true,
        eventId: true,
        eventType: true,
        payloadHash: true,
        attempt: true,
        lineageId: true,
        replayOf: true,
        schemaVersion: true,
        createdAt: true,
      },
    });

    if (!stored || stored.webhookId !== webhookId) {
      throw new NotFoundException("Delivery receipt not found");
    }

    // The receipt model is relation-free, so the delivery outcome is read
    // with a second query. A missing delivery row (never deleted in
    // practice) is reported as not found, like a missing receipt.
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: stored.deliveryId },
      select: { status: true, deliveredAt: true },
    });
    if (!delivery) {
      throw new NotFoundException("Delivery receipt not found");
    }

    return {
      ...stored,
      source: "stored",
      status: delivery.status,
      deliveredAt: delivery.deliveredAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Like `assertOwnedWebhook`, but also returns `url` and `secretEncrypted`. */
  private async assertOwnedWebhookFull(organizationId: string, webhookId: string) {
    const webhook = await this.prisma.webhook.findUnique({
      where: { id: webhookId },
      select: {
        id: true,
        organizationId: true,
        url: true,
        secretEncrypted: true,
        status: true,
        revision: true,
      },
    });
    this.assertOwnership(webhook, organizationId, webhookId);
    return webhook!;
  }

  private async assertOwnedWebhook(organizationId: string, webhookId: string) {
    const webhook = await this.prisma.webhook.findUnique({
      where: { id: webhookId },
      select: { id: true, organizationId: true, status: true, revision: true },
    });
    this.assertOwnership(webhook, organizationId, webhookId);
    return webhook!;
  }

  private assertOwnership(
    webhook: { organizationId: string } | null,
    organizationId: string,
    webhookId: string,
  ): void {
    if (!webhook) {
      throw new NotFoundException(`Webhook ${webhookId} not found`);
    }
    if (webhook.organizationId !== organizationId) {
      throw new ForbiddenException("Webhook does not belong to this organisation");
    }
  }

  /** Expose decrypt for testing secret rotation. */
  revealSecret(secretEncrypted: string): string {
    return this.paymentEncryptionKeyring.decrypt(secretEncrypted);
  }

  /**
   * Preview a predicate against a sample event.
   *
   * Tests whether a predicate matches a given event without creating a delivery
   * or modifying any state. Returns the match result and budget usage.
   *
   * Authorization: caller must have an active organization (already checked by controller).
   * No webhook-specific permission needed; this is a read-only test endpoint.
   *
   * @param organizationId Tenant context (for audit/rate limiting)
   * @param predicateRaw Raw predicate object (must be validated by class-validator)
   * @param eventRaw Raw event object (must be validated by class-validator)
   * @returns Match result with budget usage
   */
  async previewPredicate(
    organizationId: string,
    predicateRaw: any,
    eventRaw: any,
  ): Promise<{ match: boolean; reason?: string; visitedNodes: number }> {
    if (!this.predicatePreviewService) {
      return { match: true, visitedNodes: 0 };
    }
    return this.predicatePreviewService.preview(predicateRaw, eventRaw);
  }
}

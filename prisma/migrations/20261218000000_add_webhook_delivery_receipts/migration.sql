-- Webhook delivery idempotency receipts.
-- Additive only. Adds a nullable retry-chain identifier to deliveries and a
-- receipt ledger: one row per delivery attempt, keyed by a deterministic,
-- versioned receipt id bound to event, endpoint, attempt lineage, and
-- payload hash. Receipt rows hold no signing secret and no payload content
-- (only its SHA-256), so they cannot authorize a replay or reveal another
-- tenant's event. Rows created before this migration keep lineageId NULL and
-- resolve to their own id as lineage root; receipts for them are derived
-- on read, never backfilled.

-- AlterTable
ALTER TABLE "WebhookDelivery" ADD COLUMN "lineageId" TEXT;

-- CreateIndex
CREATE INDEX "WebhookDelivery_lineageId_idx" ON "WebhookDelivery"("lineageId");

-- CreateTable
CREATE TABLE "WebhookDeliveryReceipt" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1',
    "webhookId" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "lineageId" TEXT NOT NULL,
    "replayOf" TEXT,
    "schemaVersion" TEXT NOT NULL DEFAULT '1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDeliveryReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDeliveryReceipt_receiptId_key" ON "WebhookDeliveryReceipt"("receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDeliveryReceipt_deliveryId_key" ON "WebhookDeliveryReceipt"("deliveryId");

-- CreateIndex
CREATE INDEX "WebhookDeliveryReceipt_webhookId_eventId_idx" ON "WebhookDeliveryReceipt"("webhookId", "eventId");

-- CreateIndex
CREATE INDEX "WebhookDeliveryReceipt_lineageId_idx" ON "WebhookDeliveryReceipt"("lineageId");

-- CreateIndex
CREATE INDEX "WebhookDeliveryReceipt_eventId_idx" ON "WebhookDeliveryReceipt"("eventId");
-- No foreign keys: the model is deliberately relation-free (see
-- prisma/schema.prisma). Webhooks are soft-deleted and deliveries are never
-- deleted, so FKs would buy no integrity here; `webhookId` and
-- `deliveryId` are denormalized references written from the delivery row.

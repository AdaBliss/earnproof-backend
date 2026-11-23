-- Per-attempt DNS resolution pinning fields (#371)
-- These fields track DNS resolution metadata for observability and diagnostics

ALTER TABLE "WebhookDelivery" ADD COLUMN "dnsPinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "WebhookDelivery" ADD COLUMN "dnsResolutionMs" INTEGER;
ALTER TABLE "WebhookDelivery" ADD COLUMN "dnsAddressCount" INTEGER;

-- Index for querying pinned vs non-pinned deliveries
CREATE INDEX "WebhookDelivery_dnsPinned_idx" ON "WebhookDelivery"("dnsPinned");

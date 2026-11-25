-- W3C trace context propagation across durable queues (issue #429).
--
-- Nullable, additive columns only: existing rows and writers that do not set
-- them are unaffected, and a null context simply starts a fresh trace when the
-- row is processed. No backfill is needed and no index is added; the values are
-- carried, never queried.

ALTER TABLE "AnchoringIntent"
  ADD COLUMN "traceparent" VARCHAR(55),
  ADD COLUMN "tracestate" VARCHAR(512);

ALTER TABLE "WebhookDelivery"
  ADD COLUMN "traceparent" VARCHAR(55),
  ADD COLUMN "tracestate" VARCHAR(512);

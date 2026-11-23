import { canonicalize } from "../common/crypto/canonicalize";
import { sha256 } from "../common/crypto/hash";

/**
 * Versioned webhook delivery idempotency receipts.
 *
 * A receipt binds one delivery *attempt* to the event, the endpoint, the
 * attempt lineage, and the exact payload bytes that were signed and sent:
 *
 *   receiptId = "wr_v1_" + SHA-256(canonicalJson({
 *     version, eventId, webhookId, eventType, payloadHash,
 *     attempt, lineageId, replayOf,
 *   }))
 *
 * where `payloadHash` is the SHA-256 of the exact serialized payload bytes
 * (`WebhookDelivery.payloadBody`) and `lineageId` is the identifier of the
 * retry chain the attempt belongs to (the first attempt's delivery id for a
 * fresh chain; a new random id for a replay/redrive chain).
 *
 * Properties the acceptance criteria require:
 *
 * - Deterministic: the id is a pure function of stored delivery fields. No
 *   timestamp, randomness, or secret enters the hash, so recomputing a
 *   receipt for the same delivery row always yields the same id, and a
 *   receipt issued before a migration can be re-derived afterwards.
 * - Bounded: the id is always exactly `wr_v1_` + 64 lowercase hex chars
 *   (70 chars). Every bound field is length-checked before hashing.
 * - No secret, no authority: the hash is an *unkeyed* SHA-256 over public
 *   identifiers and a payload digest. It contains no signing secret, is not
 *   an HMAC, and cannot authorize a replay or verify a signature — knowing
 *   a receipt id gives an attacker nothing the delivery headers do not
 *   already carry. A receipt also carries no payload content, only its
 *   digest, so it cannot reveal another tenant's event.
 * - Lineage-aware: retries share `lineageId` and differ by `attempt`;
 *   replays/redrives start a fresh `lineageId` and carry `replayOf`, so a
 *   replayed attempt never collides with the original attempt even though
 *   both share `eventId`, endpoint, and payload bytes.
 *
 * The canonical-hash approach is reused from `src/common/crypto`
 * (`canonicalize` + `sha256`): the same deterministic JSON canonicalization
 * the request-signing path relies on, rather than a second scheme.
 *
 * This module is pure: it never touches the database, the clock, or a
 * secret, so it is unit-testable without Prisma or Nest.
 */

/** Receipt scheme version. Bump on any change to the id format or inputs. */
export const WEBHOOK_RECEIPT_VERSION = "1" as const;

/** Prefix of every receipt id. The version is part of the prefix. */
export const WEBHOOK_RECEIPT_ID_PREFIX = `wr_v${WEBHOOK_RECEIPT_VERSION}_` as const;

/** A receipt id is the prefix plus one SHA-256 hex digest (70 chars). */
export const WEBHOOK_RECEIPT_ID_LENGTH =
  WEBHOOK_RECEIPT_ID_PREFIX.length + 64;

/** Maximum length of any identifier bound into a receipt. */
export const MAX_RECEIPT_FIELD_LENGTH = 128;

/** Largest attempt number a receipt can bind. Real chains stop at 5. */
export const MAX_RECEIPT_ATTEMPT = 10_000;

/** `wr_v1_` followed by exactly 64 lowercase hex characters. */
export const WEBHOOK_RECEIPT_ID_PATTERN = /^wr_v1_[0-9a-f]{64}$/;

/** A SHA-256 digest as 64 lowercase hex characters. */
export const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Fields a receipt is computed from — all already stored on the delivery row. */
export interface WebhookDeliveryReceiptInput {
  /** Delivery row id (the attempt this receipt is for). */
  deliveryId: string;
  /** Endpoint id. */
  webhookId: string;
  /** Stable event identifier, shared across endpoints and retries. */
  eventId: string;
  /** Allowlisted event type, e.g. `proof.created`. */
  eventType: string;
  /** Exact serialized payload bytes that were signed and sent. */
  payloadBody: string;
  /** Attempt number within its lineage (1 = first attempt). */
  attempt: number;
  /**
   * Retry-chain identifier. `null`/`undefined` only for rows created before
   * receipts existed; those resolve to the delivery's own id (each legacy
   * row is its own lineage root).
   */
  lineageId?: string | null;
  /** Delivery id this attempt replays/redrives, or null for an original. */
  replayOf?: string | null;
  /** Payload schema version carried by the delivery. */
  schemaVersion: string;
}

/** A computed receipt: the id plus every field it binds. */
export interface WebhookDeliveryReceiptData {
  receiptId: string;
  version: typeof WEBHOOK_RECEIPT_VERSION;
  webhookId: string;
  deliveryId: string;
  eventId: string;
  eventType: string;
  /** SHA-256 of the exact payload bytes. No payload content is stored. */
  payloadHash: string;
  attempt: number;
  lineageId: string;
  replayOf: string | null;
  schemaVersion: string;
}

/** Raised when a receipt cannot be built from the supplied fields. */
export class InvalidReceiptInputError extends Error {
  constructor(message: string) {
    super(`Invalid webhook delivery receipt input: ${message}`);
    this.name = "InvalidReceiptInputError";
  }
}

/**
 * SHA-256 of the exact payload bytes, hex-encoded.
 *
 * The body is hashed as sent — never parsed and re-serialized — so the
 * digest matches the bytes the signature covers.
 */
export function computePayloadHash(payloadBody: string): string {
  if (typeof payloadBody !== "string") {
    throw new InvalidReceiptInputError("payloadBody must be a string");
  }
  return sha256(payloadBody);
}

/**
 * Resolve the lineage an attempt belongs to.
 *
 * A fresh chain's lineage is its first attempt's delivery id; a
 * replay/redrive chain carries the fresh id stored on its rows. Legacy rows
 * (created before `lineageId` existed) resolve to their own id.
 */
export function resolveLineageId(
  deliveryId: string,
  lineageId?: string | null,
): string {
  if (lineageId !== undefined && lineageId !== null) {
    return lineageId;
  }
  return deliveryId;
}

/**
 * Compute the versioned receipt id for already-validated binding fields.
 *
 * Pure and deterministic: the same inputs always produce the same id.
 */
export function computeReceiptId(input: {
  eventId: string;
  webhookId: string;
  eventType: string;
  payloadHash: string;
  attempt: number;
  lineageId: string;
  replayOf: string | null;
}): string {
  validateBoundField("eventId", input.eventId);
  validateBoundField("webhookId", input.webhookId);
  validateBoundField("eventType", input.eventType);
  validateBoundField("lineageId", input.lineageId);
  if (input.replayOf !== null) {
    validateBoundField("replayOf", input.replayOf);
  }
  if (!PAYLOAD_HASH_PATTERN.test(input.payloadHash)) {
    throw new InvalidReceiptInputError(
      "payloadHash must be a SHA-256 hex digest (64 lowercase hex characters)",
    );
  }
  if (
    !Number.isInteger(input.attempt) ||
    input.attempt < 1 ||
    input.attempt > MAX_RECEIPT_ATTEMPT
  ) {
    throw new InvalidReceiptInputError(
      `attempt must be an integer between 1 and ${MAX_RECEIPT_ATTEMPT}`,
    );
  }

  const digest = sha256(
    canonicalize({
      version: WEBHOOK_RECEIPT_VERSION,
      eventId: input.eventId,
      webhookId: input.webhookId,
      eventType: input.eventType,
      payloadHash: input.payloadHash,
      attempt: input.attempt,
      lineageId: input.lineageId,
      replayOf: input.replayOf,
    }),
  );
  return `${WEBHOOK_RECEIPT_ID_PREFIX}${digest}`;
}

/**
 * Build the full receipt for one delivery attempt.
 *
 * Validates every bound field, hashes the exact payload bytes, and derives
 * the deterministic receipt id. Throws {@link InvalidReceiptInputError} on
 * any invalid input rather than issuing a receipt that could collide or
 * misidentify a delivery.
 */
export function buildDeliveryReceipt(
  input: WebhookDeliveryReceiptInput,
): WebhookDeliveryReceiptData {
  validateBoundField("deliveryId", input.deliveryId);
  validateBoundField("schemaVersion", input.schemaVersion);
  const lineageId = resolveLineageId(input.deliveryId, input.lineageId);
  validateBoundField("lineageId", lineageId);
  const payloadHash = computePayloadHash(input.payloadBody);
  const receiptId = computeReceiptId({
    eventId: input.eventId,
    webhookId: input.webhookId,
    eventType: input.eventType,
    payloadHash,
    attempt: input.attempt,
    lineageId,
    replayOf: input.replayOf ?? null,
  });

  return {
    receiptId,
    version: WEBHOOK_RECEIPT_VERSION,
    webhookId: input.webhookId,
    deliveryId: input.deliveryId,
    eventId: input.eventId,
    eventType: input.eventType,
    payloadHash,
    attempt: input.attempt,
    lineageId,
    replayOf: input.replayOf ?? null,
    schemaVersion: input.schemaVersion,
  };
}

/** True when `value` is a well-formed receipt id for the current version. */
export function isValidReceiptId(value: unknown): boolean {
  return (
    typeof value === "string" && WEBHOOK_RECEIPT_ID_PATTERN.test(value)
  );
}

function validateBoundField(name: string, value: unknown): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidReceiptInputError(`${name} must be a non-empty string`);
  }
  if (value.length > MAX_RECEIPT_FIELD_LENGTH) {
    throw new InvalidReceiptInputError(
      `${name} must be at most ${MAX_RECEIPT_FIELD_LENGTH} characters`,
    );
  }
}

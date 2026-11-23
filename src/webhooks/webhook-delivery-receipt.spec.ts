import { createHash } from "crypto";
import {
  InvalidReceiptInputError,
  MAX_RECEIPT_ATTEMPT,
  MAX_RECEIPT_FIELD_LENGTH,
  WEBHOOK_RECEIPT_ID_LENGTH,
  WEBHOOK_RECEIPT_ID_PREFIX,
  buildDeliveryReceipt,
  computePayloadHash,
  computeReceiptId,
  isValidReceiptId,
  resolveLineageId,
  type WebhookDeliveryReceiptInput,
} from "./webhook-delivery-receipt";
import { WebhookSigningService } from "./webhook-signing.service";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function makeInput(
  overrides: Partial<WebhookDeliveryReceiptInput> = {},
): WebhookDeliveryReceiptInput {
  return {
    deliveryId: "delivery_1",
    webhookId: "webhook_1",
    eventId: "evt_1",
    eventType: "proof.created",
    payloadBody: '{"specVersion":"1","id":"evt_1"}',
    attempt: 1,
    lineageId: "delivery_1",
    replayOf: null,
    schemaVersion: "1",
    ...overrides,
  };
}

describe("webhook delivery idempotency receipts", () => {
  describe("buildDeliveryReceipt (positive)", () => {
    it("issues a versioned receipt id bound to the delivery", () => {
      const receipt = buildDeliveryReceipt(makeInput());

      expect(receipt.version).toBe("1");
      expect(receipt.receiptId.startsWith(WEBHOOK_RECEIPT_ID_PREFIX)).toBe(
        true,
      );
      expect(receipt.receiptId).toHaveLength(WEBHOOK_RECEIPT_ID_LENGTH);
      expect(isValidReceiptId(receipt.receiptId)).toBe(true);
      expect(receipt.deliveryId).toBe("delivery_1");
      expect(receipt.webhookId).toBe("webhook_1");
      expect(receipt.eventId).toBe("evt_1");
      expect(receipt.eventType).toBe("proof.created");
      expect(receipt.attempt).toBe(1);
      expect(receipt.lineageId).toBe("delivery_1");
      expect(receipt.replayOf).toBeNull();
      expect(receipt.schemaVersion).toBe("1");
    });

    it("matches an independently computed vector", () => {
      // Canonical JSON of the binding fields, keys sorted alphabetically,
      // hashed with plain SHA-256 — recomputed here with node:crypto only,
      // so the test does not just re-run the implementation.
      const body = '{"specVersion":"1","id":"evt_1"}';
      const payloadHash = sha256(body);
      const canonical = JSON.stringify({
        attempt: 1,
        eventId: "evt_1",
        eventType: "proof.created",
        lineageId: "lin_1",
        payloadHash,
        replayOf: null,
        version: "1",
        webhookId: "wh_1",
      });
      const expected = `wr_v1_${sha256(canonical)}`;

      const receipt = buildDeliveryReceipt(
        makeInput({
          deliveryId: "delivery_1",
          webhookId: "wh_1",
          eventId: "evt_1",
          lineageId: "lin_1",
          payloadBody: body,
        }),
      );
      expect(receipt.payloadHash).toBe(payloadHash);
      expect(receipt.receiptId).toBe(expected);
    });

    it("is deterministic: same inputs always give the same receipt", () => {
      const first = buildDeliveryReceipt(makeInput());
      const second = buildDeliveryReceipt(makeInput());
      expect(second).toEqual(first);
    });

    it("does not depend on the order fields are supplied in", () => {
      const reordered = buildDeliveryReceipt({
        schemaVersion: "1",
        replayOf: null,
        lineageId: "delivery_1",
        attempt: 1,
        payloadBody: '{"specVersion":"1","id":"evt_1"}',
        eventType: "proof.created",
        eventId: "evt_1",
        webhookId: "webhook_1",
        deliveryId: "delivery_1",
      });
      expect(reordered.receiptId).toBe(
        buildDeliveryReceipt(makeInput()).receiptId,
      );
    });

    it("hashes the exact payload bytes", () => {
      expect(computePayloadHash('{"a":1}')).toBe(sha256('{"a":1}'));
      // Key order is part of the bytes: a re-serialized body is a
      // different payload and must hash differently.
      expect(computePayloadHash('{"a":1,"b":2}')).not.toBe(
        computePayloadHash('{"b":2,"a":1}'),
      );
    });
  });

  describe("binding sensitivity (negative / regression)", () => {
    it.each([
      ["eventId", { eventId: "evt_2" }],
      ["webhookId", { webhookId: "webhook_2" }],
      ["eventType", { eventType: "proof.revoked" }],
      ["payloadBody", { payloadBody: '{"specVersion":"1","id":"evt_2"}' }],
      ["attempt", { attempt: 2 }],
      ["lineageId", { lineageId: "other_lineage" }],
      ["replayOf", { replayOf: "delivery_0" }],
    ] as const)(
      "changes the receipt id when %s changes",
      (_name, override) => {
        expect(buildDeliveryReceipt(makeInput(override)).receiptId).not.toBe(
          buildDeliveryReceipt(makeInput()).receiptId,
        );
      },
    );

    it("distinguishes a retry from the first attempt", () => {
      const first = buildDeliveryReceipt(makeInput({ attempt: 1 }));
      const retry = buildDeliveryReceipt(makeInput({ attempt: 2 }));
      expect(retry.receiptId).not.toBe(first.receiptId);
      expect(retry.lineageId).toBe(first.lineageId);
    });

    it("distinguishes a replay from the original attempt", () => {
      const original = buildDeliveryReceipt(makeInput());
      const replay = buildDeliveryReceipt(
        makeInput({
          deliveryId: "delivery_replay",
          lineageId: "fresh_lineage",
          replayOf: "delivery_1",
        }),
      );
      expect(replay.receiptId).not.toBe(original.receiptId);
      // Same event, endpoint, and payload — only lineage/replayOf differ.
      expect(replay.eventId).toBe(original.eventId);
      expect(replay.payloadHash).toBe(original.payloadHash);
    });

    it("distinguishes a redrive from a replay of the same dead letter", () => {
      const replay = buildDeliveryReceipt(
        makeInput({
          deliveryId: "delivery_replay",
          lineageId: "lineage_replay",
          replayOf: "delivery_1",
        }),
      );
      const redrive = buildDeliveryReceipt(
        makeInput({
          deliveryId: "delivery_redrive",
          lineageId: "lineage_redrive",
          replayOf: "delivery_1",
        }),
      );
      expect(redrive.receiptId).not.toBe(replay.receiptId);
    });
  });

  describe("no secret, no authority", () => {
    it("contains no signing secret anywhere in the receipt", () => {
      const secret = "9f".repeat(32);
      const receipt = buildDeliveryReceipt(makeInput());
      const serialized = JSON.stringify(receipt);
      expect(serialized).not.toContain(secret);
      // The receipt id is an unkeyed hash, not an HMAC: it is not derived
      // from the secret at all, so it cannot leak it either.
      expect(receipt.receiptId).not.toContain(secret.slice(0, 8));
    });

    it("cannot authorize a delivery: it is not a valid signature", () => {
      const signing = new WebhookSigningService();
      const secret = "9f".repeat(32);
      const body = '{"specVersion":"1","id":"evt_1"}';
      const timestamp = 1724400000;
      const receipt = buildDeliveryReceipt(makeInput({ payloadBody: body }));

      const genuine = signing.sign(secret, timestamp, "evt_1", body);
      expect(signing.verify(secret, timestamp, "evt_1", body, genuine)).toBe(
        true,
      );
      // A receipt id presented as a signature, or as the signing key, fails.
      expect(
        signing.verify(secret, timestamp, "evt_1", body, receipt.receiptId),
      ).toBe(false);
      expect(
        signing.verify(
          receipt.receiptId,
          timestamp,
          "evt_1",
          body,
          genuine,
        ),
      ).toBe(false);
    });

    it("carries no payload content, only its digest", () => {
      const receipt = buildDeliveryReceipt(
        makeInput({ payloadBody: '{"proofId":"proof_secret_value"}' }),
      );
      expect(JSON.stringify(receipt)).not.toContain("proof_secret_value");
      expect(receipt.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("validation (negative)", () => {
    it.each([
      ["deliveryId", { deliveryId: "" }],
      ["webhookId", { webhookId: "" }],
      ["eventId", { eventId: "" }],
      ["eventType", { eventType: "" }],
      ["schemaVersion", { schemaVersion: "" }],
      ["lineageId", { lineageId: "" }],
      ["replayOf", { replayOf: "" }],
    ] as const)("rejects an empty %s", (_name, override) => {
      expect(() => buildDeliveryReceipt(makeInput(override))).toThrow(
        InvalidReceiptInputError,
      );
    });

    it.each([[0], [-1], [1.5], [Number.NaN], [MAX_RECEIPT_ATTEMPT + 1]])(
      "rejects attempt %s",
      (attempt) => {
        expect(() =>
          buildDeliveryReceipt(makeInput({ attempt })),
        ).toThrow(InvalidReceiptInputError);
      },
    );

    it("rejects a non-string payload body", () => {
      expect(() =>
        buildDeliveryReceipt(
          makeInput({ payloadBody: 42 as unknown as string }),
        ),
      ).toThrow(InvalidReceiptInputError);
    });

    it("rejects a malformed payload hash in computeReceiptId", () => {
      expect(() =>
        computeReceiptId({
          eventId: "evt_1",
          webhookId: "wh_1",
          eventType: "proof.created",
          payloadHash: "not-a-hash",
          attempt: 1,
          lineageId: "lin_1",
          replayOf: null,
        }),
      ).toThrow(InvalidReceiptInputError);
    });
  });

  describe("boundaries", () => {
    it("accepts identifiers at the maximum length", () => {
      const max = "x".repeat(MAX_RECEIPT_FIELD_LENGTH);
      const receipt = buildDeliveryReceipt(
        makeInput({ eventId: max, webhookId: max, lineageId: max }),
      );
      expect(receipt.receiptId).toHaveLength(WEBHOOK_RECEIPT_ID_LENGTH);
    });

    it("rejects identifiers one character over the maximum length", () => {
      const over = "x".repeat(MAX_RECEIPT_FIELD_LENGTH + 1);
      expect(() =>
        buildDeliveryReceipt(makeInput({ eventId: over })),
      ).toThrow(InvalidReceiptInputError);
    });

    it("accepts the smallest and largest attempt numbers", () => {
      expect(buildDeliveryReceipt(makeInput({ attempt: 1 })).attempt).toBe(1);
      expect(
        buildDeliveryReceipt(makeInput({ attempt: MAX_RECEIPT_ATTEMPT }))
          .attempt,
      ).toBe(MAX_RECEIPT_ATTEMPT);
    });

    it("hashes an empty payload body to the SHA-256 of empty input", () => {
      expect(computePayloadHash("")).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );
      expect(buildDeliveryReceipt(makeInput({ payloadBody: "" }))).toBeTruthy();
    });
  });

  describe("lineage resolution and id format", () => {
    it("resolves a missing lineage to the delivery's own id (legacy rows)", () => {
      expect(resolveLineageId("delivery_9", null)).toBe("delivery_9");
      expect(resolveLineageId("delivery_9", undefined)).toBe("delivery_9");
      expect(resolveLineageId("delivery_9", "chain_1")).toBe("chain_1");
      const receipt = buildDeliveryReceipt(
        makeInput({ deliveryId: "delivery_9", lineageId: null }),
      );
      expect(receipt.lineageId).toBe("delivery_9");
    });

    it("validates receipt id format strictly", () => {
      const receipt = buildDeliveryReceipt(makeInput());
      expect(isValidReceiptId(receipt.receiptId)).toBe(true);
      expect(isValidReceiptId("wr_v1_" + "0".repeat(63))).toBe(false);
      expect(isValidReceiptId("wr_v1_" + "0".repeat(65))).toBe(false);
      expect(isValidReceiptId("wr_v2_" + "0".repeat(64))).toBe(false);
      expect(isValidReceiptId("wr_v1_" + "G".repeat(64))).toBe(false);
      expect(isValidReceiptId("")).toBe(false);
      expect(isValidReceiptId(undefined)).toBe(false);
      expect(isValidReceiptId(42)).toBe(false);
    });
  });
});

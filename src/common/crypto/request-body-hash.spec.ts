import { readFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { canonicalize } from "./canonicalize";
import { sha256 } from "./hash";
import {
  MAX_REQUEST_BODY_CANONICAL_BYTES,
  MAX_REQUEST_BODY_HASH_DEPTH,
  RequestBodyTooLargeError,
  UncanonicalizableRequestBodyError,
  UnsupportedPayloadHashVersionError,
  canonicalizeRequestBody,
  hashRequestBody,
  isSensitivePayloadKey,
  redactSensitivePayloadKeys,
  verifyRequestBodyHash,
} from "./request-body-hash";

interface GoldenVector {
  name: string;
  version: number;
  payload: unknown;
  canonical: string;
  hash: string;
  redactedKeys: string[];
}

function loadGoldenVectors(): GoldenVector[] {
  const raw = readFileSync(
    join(__dirname, "testdata", "request-body-hash-vectors.v1.json"),
    "utf8",
  );
  const parsed = JSON.parse(raw) as { version: number; vectors: GoldenVector[] };
  return parsed.vectors;
}

describe("request body hashing (v1)", () => {
  // ---------------------------------------------------------------------
  // Cross-runtime golden vectors — canonical form and hash produced by an
  // independent Python implementation (scripts/generate-request-body-hash-vectors.py).
  // If Node and Python ever disagree on a byte, these fail.
  // ---------------------------------------------------------------------

  describe("cross-runtime golden vectors (Python)", () => {
    const vectors = loadGoldenVectors();

    it("has vectors to check", () => {
      expect(vectors.length).toBeGreaterThan(0);
    });

    it.each(loadGoldenVectors())(
      "vector $name: canonical form matches Python",
      (vector) => {
        expect(canonicalizeRequestBody(vector.payload, vector.version)).toBe(
          vector.canonical,
        );
      },
    );

    it.each(loadGoldenVectors())(
      "vector $name: hash matches Python",
      (vector) => {
        const result = hashRequestBody(vector.payload, vector.version);
        expect(result.version).toBe(vector.version);
        expect(result.hash).toBe(vector.hash);
        expect(result.redactedKeys).toEqual(vector.redactedKeys);
        expect(result.canonicalLength).toBe(
          Buffer.byteLength(vector.canonical, "utf8"),
        );
      },
    );

    it("agrees with Node crypto computed directly from the fixture canonical form", () => {
      for (const vector of vectors) {
        expect(
          createHash("sha256").update(vector.canonical, "utf8").digest("hex"),
        ).toBe(vector.hash);
      }
    });
  });

  // ---------------------------------------------------------------------
  // Second in-repo path: the new canonicalizer agrees with the existing
  // canonicalize()/sha256() helpers on payloads without secrets.
  // ---------------------------------------------------------------------

  describe("agreement with existing canonicalize()", () => {
    it("matches sha256(canonicalize(payload)) for secret-free payloads", () => {
      const payloads = [
        { b: 1, a: "x" },
        { z: { b: [3, 2, 1], a: null }, a: true },
        { items: [{ b: 2, a: 1 }, "x", null, false] },
        { nested: { deep: { deeper: [1, { y: 2, x: 1 }] } } },
      ];
      for (const payload of payloads) {
        expect(hashRequestBody(payload).hash).toBe(sha256(canonicalize(payload)));
        expect(canonicalizeRequestBody(payload)).toBe(canonicalize(payload));
      }
    });
  });

  // ---------------------------------------------------------------------
  // Positive: determinism and key-order independence
  // ---------------------------------------------------------------------

  describe("determinism", () => {
    it("is independent of key insertion order, including nested objects", () => {
      const first = { b: 1, a: { d: 4, c: 3 } };
      const second = { a: { c: 3, d: 4 }, b: 1 };
      expect(hashRequestBody(first)).toEqual(hashRequestBody(second));
      expect(canonicalizeRequestBody(first)).toBe(canonicalizeRequestBody(second));
    });

    it("preserves array order — reordering an array changes the hash", () => {
      const ordered = hashRequestBody({ items: [1, 2, 3] });
      const reordered = hashRequestBody({ items: [3, 2, 1] });
      expect(ordered.hash).not.toBe(reordered.hash);
    });

    it("normalizes -0 to 0 so the two spellings hash identically", () => {
      expect(canonicalizeRequestBody({ n: -0 })).toBe('{"n":0}');
      expect(hashRequestBody({ n: -0 }).hash).toBe(hashRequestBody({ n: 0 }).hash);
    });

    it("is stable across repeated calls", () => {
      const payload = { a: [1, { b: "x" }], c: null };
      expect(hashRequestBody(payload)).toEqual(hashRequestBody(payload));
    });
  });

  // ---------------------------------------------------------------------
  // Negative: secrets excluded from the hash input
  // ---------------------------------------------------------------------

  describe("secret exclusion", () => {
    it.each([
      ["secret", true],
      ["apiKey", true],
      ["api_key", true],
      ["API-KEY", true],
      ["password", true],
      ["passwd", true],
      ["privateKey", true],
      ["private_key", true],
      ["accessToken", true],
      ["authToken", true],
      ["refreshToken", true],
      ["executionLeaseToken", true],
      ["token", true],
      ["bearer", true],
      ["clientSecret", true],
      ["webhookSecret", true],
      ["signingKey", true],
      ["encryptionKey", true],
      ["credential", true],
      ["seedPhrase", true],
      ["mnemonic", true],
      ["tokenId", false],
      ["amount", false],
      ["address", false],
      ["organizationId", false],
      ["reason", false],
    ])("isSensitivePayloadKey(%s) === %s", (key, expected) => {
      expect(isSensitivePayloadKey(key)).toBe(expected);
    });

    it("changing only a secret value does not change the hash", () => {
      const base = { organizationId: "org_1", apiKey: "sk-first" };
      const rotated = { organizationId: "org_1", apiKey: "sk-second" };
      expect(hashRequestBody(base)).toEqual(hashRequestBody(rotated));
    });

    it("strips secrets at any depth and reports their paths", () => {
      const payload = {
        keep: 1,
        config: { apiKey: "sk-x", nested: { password: "pw" } },
        list: [{ token: "t" }, { ok: true }],
      };
      const { value, redactedKeys } = redactSensitivePayloadKeys(payload);
      expect(value).toEqual({
        keep: 1,
        config: { nested: {} },
        list: [{}, { ok: true }],
      });
      expect(redactedKeys).toEqual([
        "config.apiKey",
        "config.nested.password",
        "list[0].token",
      ]);
      // The original payload is not mutated.
      expect(payload.config.apiKey).toBe("sk-x");
    });

    it("redacts a secret-bearing container key wholesale", () => {
      const { value, redactedKeys } = redactSensitivePayloadKeys({
        credentials: { apiKey: "sk-x" },
        keep: 1,
      });
      expect(value).toEqual({ keep: 1 });
      expect(redactedKeys).toEqual(["credentials"]);
    });

    it("does not redact identifiers or reviewed parameters", () => {
      const payload = { tokenId: "tok_123", amount: "500.0000000", address: "0xabc" };
      expect(hashRequestBody(payload).redactedKeys).toEqual([]);
      expect(hashRequestBody(payload).hash).toBe(sha256(canonicalize(payload)));
    });
  });

  // ---------------------------------------------------------------------
  // Negative: unknown versions fail closed; uncanonicalizable values fail closed
  // ---------------------------------------------------------------------

  describe("fail-closed", () => {
    it("throws for an unknown hash version", () => {
      expect(() => hashRequestBody({ a: 1 }, 2)).toThrow(
        UnsupportedPayloadHashVersionError,
      );
      expect(() => hashRequestBody({ a: 1 }, 99)).toThrow(
        UnsupportedPayloadHashVersionError,
      );
      expect(() => canonicalizeRequestBody({ a: 1 }, 0)).toThrow(
        UnsupportedPayloadHashVersionError,
      );
    });

    it("verify rejects an unknown stored version instead of matching", () => {
      expect(() =>
        verifyRequestBodyHash({ payloadHashVersion: 99, payloadHash: "00" }, { a: 1 }),
      ).toThrow(UnsupportedPayloadHashVersionError);
    });

    it("verify returns false on a mismatched hash", () => {
      const stored = hashRequestBody({ a: 1 });
      expect(
        verifyRequestBodyHash(
          { payloadHashVersion: stored.version, payloadHash: stored.hash },
          { a: 2 },
        ),
      ).toBe(false);
    });

    it("verify accepts a stored hash with an absent version (pre-versioning rows)", () => {
      const stored = hashRequestBody({ a: 1 });
      expect(
        verifyRequestBodyHash({ payloadHash: stored.hash }, { a: 1 }),
      ).toBe(true);
    });

    it("verify does not accept the legacy unredacted hash unless explicitly allowed", () => {
      const payload = { a: 1, apiKey: "sk-x" };
      const legacyHash = sha256(canonicalize(payload));
      const stored = { payloadHashVersion: 1, payloadHash: legacyHash };
      expect(verifyRequestBodyHash(stored, payload)).toBe(false);
      expect(
        verifyRequestBodyHash(stored, payload, { allowLegacyUnredacted: true }),
      ).toBe(true);
    });

    it("rejects non-finite numbers instead of coercing them to null", () => {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(() => hashRequestBody({ n: bad })).toThrow(
          UncanonicalizableRequestBodyError,
        );
      }
    });

    it("rejects bigints, functions, and symbols", () => {
      expect(() => hashRequestBody({ n: 1n })).toThrow(
        UncanonicalizableRequestBodyError,
      );
      expect(() => hashRequestBody({ f: () => 1 })).toThrow(
        UncanonicalizableRequestBodyError,
      );
      expect(() => hashRequestBody({ s: Symbol("x") })).toThrow(
        UncanonicalizableRequestBodyError,
      );
    });

    it("rejects circular structures", () => {
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;
      expect(() => hashRequestBody(circular)).toThrow(
        UncanonicalizableRequestBodyError,
      );
      const inArray: unknown[] = [1];
      inArray.push(inArray);
      expect(() => hashRequestBody({ items: inArray })).toThrow(
        UncanonicalizableRequestBodyError,
      );
    });
  });

  // ---------------------------------------------------------------------
  // Boundary: depth and size limits
  // ---------------------------------------------------------------------

  describe("bounds", () => {
    function nested(depth: number): unknown {
      let value: unknown = "leaf";
      for (let i = 0; i < depth; i++) value = { next: value };
      return value;
    }

    it(`accepts nesting at exactly depth ${MAX_REQUEST_BODY_HASH_DEPTH}`, () => {
      // Root object counts as depth 1; 31 nested wrappers reach depth 32.
      expect(() => hashRequestBody(nested(MAX_REQUEST_BODY_HASH_DEPTH - 1))).not.toThrow();
    });

    it(`rejects nesting beyond depth ${MAX_REQUEST_BODY_HASH_DEPTH}`, () => {
      expect(() => hashRequestBody(nested(MAX_REQUEST_BODY_HASH_DEPTH))).toThrow(
        UncanonicalizableRequestBodyError,
      );
    });

    it("rejects a canonical form over the byte limit", () => {
      const payload = { blob: "x".repeat(MAX_REQUEST_BODY_CANONICAL_BYTES) };
      expect(() => hashRequestBody(payload)).toThrow(RequestBodyTooLargeError);
    });

    it("accepts a payload just under the byte limit", () => {
      const payload = { blob: "x".repeat(MAX_REQUEST_BODY_CANONICAL_BYTES - 20) };
      expect(() => hashRequestBody(payload)).not.toThrow();
    });

    it("reports the canonical byte length, not the character length", () => {
      const result = hashRequestBody({ emoji: "🎉" });
      // '{"emoji":"🎉"}' is 14 chars but 16 bytes (emoji is 4 bytes in UTF-8).
      expect(result.canonicalLength).toBe(16);
    });
  });
});

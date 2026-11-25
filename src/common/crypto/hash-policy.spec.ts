import {
  HashAlgorithmVersion,
  HASH_POLICIES,
  CURRENT_HASH_VERSION,
  formatVersionedHash,
  parseVersionedHash,
  hashWithCurrentVersion,
  verifyVersionedHash,
  isWeakVersion,
  VersionedHash,
  HashPolicyConfig,
} from "./hash-policy";
import { randomBytes } from "crypto";

describe("HashPolicy", () => {
  describe("formatVersionedHash", () => {
    it("formats v1 hash correctly", () => {
      const versioned: VersionedHash = {
        version: HashAlgorithmVersion.V1_SHA256,
        derivedKey: Buffer.from("abcdef123456", "hex"),
      };
      const formatted = formatVersionedHash(versioned);
      expect(formatted).toMatch(/^v1:[a-f0-9]+$/);
      expect(formatted).toBe("v1:abcdef123456");
    });

    it("formats v2 hash correctly with salt", () => {
      const versioned: VersionedHash = {
        version: HashAlgorithmVersion.V2_PBKDF2_SHA256,
        salt: Buffer.from("0123456789abcdef", "hex"),
        derivedKey: Buffer.from("abcdef123456", "hex"),
      };
      const formatted = formatVersionedHash(versioned);
      expect(formatted).toMatch(/^v2:[a-f0-9]+:[a-f0-9]+$/);
      expect(formatted).toBe("v2:0123456789abcdef:abcdef123456");
    });

    it("throws on v2 hash without salt", () => {
      const versioned: VersionedHash = {
        version: HashAlgorithmVersion.V2_PBKDF2_SHA256,
        derivedKey: Buffer.from("abcdef123456", "hex"),
      };
      expect(() => formatVersionedHash(versioned)).toThrow(/salt/i);
    });
  });

  describe("parseVersionedHash", () => {
    it("parses v1 hash correctly", () => {
      const formatted = "v1:abcdef123456";
      const parsed = parseVersionedHash(formatted);
      expect(parsed.version).toBe(HashAlgorithmVersion.V1_SHA256);
      expect(parsed.derivedKey.toString("hex")).toBe("abcdef123456");
      expect(parsed.salt).toBeUndefined();
    });

    it("parses v2 hash correctly", () => {
      const formatted = "v2:0123456789abcdef:abcdef123456";
      const parsed = parseVersionedHash(formatted);
      expect(parsed.version).toBe(HashAlgorithmVersion.V2_PBKDF2_SHA256);
      expect(parsed.salt?.toString("hex")).toBe("0123456789abcdef");
      expect(parsed.derivedKey.toString("hex")).toBe("abcdef123456");
    });

    it("rejects unknown versions", () => {
      expect(() => parseVersionedHash("v99:fakehash")).toThrow(
        /unknown.*version/i,
      );
    });

    it("rejects malformed hashes", () => {
      expect(() => parseVersionedHash("malformed")).toThrow(/malformed/i);
    });

    it("rejects v1 with extra parts", () => {
      expect(() => parseVersionedHash("v1:part1:part2")).toThrow();
    });

    it("rejects v2 with wrong number of parts", () => {
      expect(() => parseVersionedHash("v2:onlyonesalt")).toThrow();
    });
  });

  describe("hashWithCurrentVersion", () => {
    it("returns a formatted versioned hash", () => {
      const plaintext = "test-token-123";
      const hash = hashWithCurrentVersion(plaintext);
      expect(hash).toMatch(/^v\d+:/);
    });

    it("includes current version in format", () => {
      const plaintext = "test-token-456";
      const hash = hashWithCurrentVersion(plaintext);
      const versionPrefix = `v${CURRENT_HASH_VERSION}:`;
      expect(hash.startsWith(versionPrefix)).toBe(true);
    });

    it("produces different hashes for different inputs (v2 has random salt)", () => {
      if (CURRENT_HASH_VERSION === HashAlgorithmVersion.V2_PBKDF2_SHA256) {
        const hash1 = hashWithCurrentVersion("token1");
        const hash2 = hashWithCurrentVersion("token1");
        // v2 has random salt, so hashes will differ
        expect(hash1).not.toBe(hash2);
      }
    });

    it("produces deterministic hashes for v1", () => {
      if (CURRENT_HASH_VERSION === HashAlgorithmVersion.V1_SHA256) {
        const hash1 = hashWithCurrentVersion("token");
        const hash2 = hashWithCurrentVersion("token");
        expect(hash1).toBe(hash2);
      }
    });
  });

  describe("verifyVersionedHash", () => {
    describe("v1 SHA-256", () => {
      it("verifies correct plaintext against v1 hash", () => {
        const plaintext = "my-test-token";
        // Create a v1 hash manually for testing
        const crypto = require("crypto");
        const derivedKey = crypto
          .createHash("sha256")
          .update(plaintext)
          .digest();
        const hash = formatVersionedHash({
          version: HashAlgorithmVersion.V1_SHA256,
          derivedKey,
        });

        const result = verifyVersionedHash(plaintext, hash);
        expect(result.valid).toBe(true);
        expect(result.version).toBe(HashAlgorithmVersion.V1_SHA256);
      });

      it("rejects wrong plaintext against v1 hash", () => {
        const plaintext = "my-test-token";
        const crypto = require("crypto");
        const derivedKey = crypto
          .createHash("sha256")
          .update(plaintext)
          .digest();
        const hash = formatVersionedHash({
          version: HashAlgorithmVersion.V1_SHA256,
          derivedKey,
        });

        const result = verifyVersionedHash("different-token", hash);
        expect(result.valid).toBe(false);
        expect(result.version).toBe(HashAlgorithmVersion.V1_SHA256);
      });
    });

    describe("v2 PBKDF2", () => {
      it("verifies correct plaintext against v2 hash", () => {
        const plaintext = "my-pbkdf2-token";
        const hash = hashWithCurrentVersion(plaintext);

        if (CURRENT_HASH_VERSION === HashAlgorithmVersion.V2_PBKDF2_SHA256) {
          const result = verifyVersionedHash(plaintext, hash);
          expect(result.valid).toBe(true);
          expect(result.version).toBe(HashAlgorithmVersion.V2_PBKDF2_SHA256);
        }
      });

      it("rejects wrong plaintext against v2 hash", () => {
        const plaintext = "my-pbkdf2-token";
        const hash = hashWithCurrentVersion(plaintext);

        if (CURRENT_HASH_VERSION === HashAlgorithmVersion.V2_PBKDF2_SHA256) {
          const result = verifyVersionedHash("wrong-plaintext", hash);
          expect(result.valid).toBe(false);
          expect(result.version).toBe(HashAlgorithmVersion.V2_PBKDF2_SHA256);
        }
      });
    });

    it("throws on unknown version", () => {
      expect(() => verifyVersionedHash("plaintext", "v99:fakehash")).toThrow(
        /unknown.*version/i,
      );
    });

    it("throws on malformed hash", () => {
      expect(() => verifyVersionedHash("plaintext", "invalid-format")).toThrow(
        /malformed/i,
      );
    });
  });

  describe("isWeakVersion", () => {
    it("identifies versions below minimum as weak", () => {
      const config: HashPolicyConfig = {
        minimumVersion: HashAlgorithmVersion.V2_PBKDF2_SHA256,
        pbkdf2Iterations: 100000,
        rejectWeakVersions: false,
      };
      expect(isWeakVersion(HashAlgorithmVersion.V1_SHA256, config)).toBe(true);
      expect(isWeakVersion(HashAlgorithmVersion.V2_PBKDF2_SHA256, config)).toBe(
        false,
      );
    });

    it("does not identify versions at or above minimum as weak", () => {
      const config: HashPolicyConfig = {
        minimumVersion: HashAlgorithmVersion.V1_SHA256,
        pbkdf2Iterations: 100000,
        rejectWeakVersions: false,
      };
      expect(isWeakVersion(HashAlgorithmVersion.V1_SHA256, config)).toBe(false);
    });
  });

  describe("round-trip: hash and verify", () => {
    it("verifies newly hashed token", () => {
      const plaintext = "round-trip-test";
      const hash = hashWithCurrentVersion(plaintext);
      const result = verifyVersionedHash(plaintext, hash);
      expect(result.valid).toBe(true);
      expect(result.version).toBe(CURRENT_HASH_VERSION);
    });

    it("rejects tampered hash", () => {
      const plaintext = "tamper-test";
      let hash = hashWithCurrentVersion(plaintext);
      // Tamper with the hash
      hash = hash.substring(0, hash.length - 1) + "X";
      const result = verifyVersionedHash(plaintext, hash);
      expect(result.valid).toBe(false);
    });
  });

  describe("policies consistency", () => {
    it("all policies have required fields", () => {
      for (const [version, policy] of Object.entries(HASH_POLICIES)) {
        expect(policy.version).toBeDefined();
        expect(policy.algorithm).toBeDefined();
        expect(policy.description).toBeDefined();
      }
    });

    it("CURRENT_HASH_VERSION exists in HASH_POLICIES", () => {
      expect(CURRENT_HASH_VERSION in HASH_POLICIES).toBe(true);
    });
  });
});

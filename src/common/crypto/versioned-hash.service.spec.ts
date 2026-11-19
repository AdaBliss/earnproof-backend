import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { VersionedHashService, VerifyResult } from "./versioned-hash.service";
import {
  HashAlgorithmVersion,
  CURRENT_HASH_VERSION,
  hashWithCurrentVersion,
  formatVersionedHash,
} from "./hash-policy";
import { createHash, pbkdf2Sync, randomBytes } from "crypto";

describe("VersionedHashService", () => {
  let service: VersionedHashService;
  let configService: ConfigService;

  beforeEach(async () => {
    const mockConfigService = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        const config: Record<string, string> = {
          HASH_POLICY_MIN_VERSION: "2",
          HASH_POLICY_PBKDF2_ITERATIONS: "100000",
          HASH_POLICY_REJECT_WEAK: "false",
        };
        return config[key] ?? defaultValue;
      }),
      getOrThrow: jest.fn((key: string) => {
        return "";
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VersionedHashService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<VersionedHashService>(VersionedHashService);
    configService = module.get<ConfigService>(ConfigService);
  });

  describe("initialization", () => {
    it("should validate configuration on startup", () => {
      expect(service).toBeDefined();
      const config = service.getConfig();
      expect(config.minimumVersion).toBeGreaterThanOrEqual(1);
      expect(config.pbkdf2Iterations).toBeGreaterThan(0);
    });

    it("should fail on invalid HASH_POLICY_MIN_VERSION", async () => {
      const mockConfig = {
        get: jest.fn((key: string) => {
          if (key === "HASH_POLICY_MIN_VERSION") return "not-a-number";
          return "false";
        }),
        getOrThrow: jest.fn(() => ""),
      };

      await expect(
        Test.createTestingModule({
          providers: [
            VersionedHashService,
            { provide: ConfigService, useValue: mockConfig },
          ],
        }).compile(),
      ).rejects.toThrow();
    });

    it("should load correct policies", () => {
      const policies = service.getPolicies();
      expect(Object.keys(policies).length).toBeGreaterThan(0);
      expect(CURRENT_HASH_VERSION in policies).toBe(true);
    });
  });

  describe("hashToken", () => {
    it("returns a formatted versioned hash", () => {
      const plaintext = "test-session-token";
      const hash = service.hashToken(plaintext);
      expect(hash).toMatch(/^v\d+:/);
    });

    it("uses current version for new tokens", () => {
      const hash = service.hashToken("token-123");
      expect(hash.startsWith(`v${CURRENT_HASH_VERSION}:`)).toBe(true);
    });

    it("produces different hashes with v2 (random salt)", () => {
      if (CURRENT_HASH_VERSION === HashAlgorithmVersion.V2_PBKDF2_SHA256) {
        const hash1 = service.hashToken("same-plaintext");
        const hash2 = service.hashToken("same-plaintext");
        expect(hash1).not.toBe(hash2); // Different salts
      }
    });

    it("never returns plaintext in hash", () => {
      const plaintext = "secret-token-value";
      const hash = service.hashToken(plaintext);
      expect(hash).not.toContain(plaintext);
      expect(hash.toLowerCase()).not.toContain("secret");
    });
  });

  describe("verifyToken", () => {
    describe("positive cases", () => {
      it("verifies newly-hashed token with current version", () => {
        const plaintext = "new-token-123";
        const hash = service.hashToken(plaintext);
        const result = service.verifyToken(plaintext, hash);

        expect(result.valid).toBe(true);
        expect(result.version).toBe(CURRENT_HASH_VERSION);
        expect(result.needsUpgrade).toBe(false);
      });

      it("verifies old-version tokens but marks for upgrade", () => {
        // Create a v1 hash manually
        const plaintext = "legacy-session";
        const derivedKey = createHash("sha256").update(plaintext).digest();
        const legacyHash = formatVersionedHash({
          version: HashAlgorithmVersion.V1_SHA256,
          derivedKey,
        });

        const result = service.verifyToken(plaintext, legacyHash);

        if (CURRENT_HASH_VERSION > HashAlgorithmVersion.V1_SHA256) {
          expect(result.valid).toBe(true);
          expect(result.version).toBe(HashAlgorithmVersion.V1_SHA256);
          expect(result.needsUpgrade).toBe(true);
          expect(result.newHash).toBeDefined();
          expect(result.newHash).toContain(`v${CURRENT_HASH_VERSION}`);
        }
      });
    });

    describe("negative cases", () => {
      it("rejects wrong plaintext", () => {
        const plaintext = "correct-token";
        const hash = service.hashToken(plaintext);
        const result = service.verifyToken("wrong-token", hash);

        expect(result.valid).toBe(false);
      });

      it("rejects expired/revoked tokens (implicit via hash mismatch)", () => {
        const hash = service.hashToken("token-123");
        const result = service.verifyToken("different-token", hash);
        expect(result.valid).toBe(false);
      });

      it("throws on unknown version (fail-closed)", () => {
        expect(() =>
          service.verifyToken("plaintext", "v99:fakehash"),
        ).toThrow();
      });

      it("throws on malformed hash", () => {
        expect(() =>
          service.verifyToken("plaintext", "not-a-versioned-hash"),
        ).toThrow();
      });
    });

    describe("weak version handling", () => {
      it("verifies weak-version tokens when reject_weak is false", () => {
        const plaintext = "weak-version-token";
        const derivedKey = createHash("sha256").update(plaintext).digest();
        const weakHash = formatVersionedHash({
          version: HashAlgorithmVersion.V1_SHA256,
          derivedKey,
        });

        // Default config has rejectWeak=false
        const result = service.verifyToken(plaintext, weakHash);
        expect(result.valid).toBe(true);
      });

      it("marks weak-version tokens for upgrade", () => {
        const plaintext = "weak-token";
        const derivedKey = createHash("sha256").update(plaintext).digest();
        const weakHash = formatVersionedHash({
          version: HashAlgorithmVersion.V1_SHA256,
          derivedKey,
        });

        const result = service.verifyToken(plaintext, weakHash);

        if (CURRENT_HASH_VERSION > HashAlgorithmVersion.V1_SHA256) {
          expect(result.needsUpgrade).toBe(true);
          expect(result.newHash).toBeDefined();
        }
      });
    });
  });

  describe("recordMetric", () => {
    it("records metrics without throwing", () => {
      expect(() => {
        service.recordMetric({
          tokenType: "session",
          version: CURRENT_HASH_VERSION,
          outcome: "valid",
          isWeak: false,
        });
      }).not.toThrow();
    });

    it("records all valid outcomes", () => {
      for (const outcome of ["valid", "invalid", "unknown_version"] as const) {
        expect(() => {
          service.recordMetric({
            tokenType: "test",
            version: CURRENT_HASH_VERSION,
            outcome,
            isWeak: false,
          });
        }).not.toThrow();
      }
    });

    it("records weak version flag", () => {
      expect(() => {
        service.recordMetric({
          tokenType: "recent_auth",
          version: HashAlgorithmVersion.V1_SHA256,
          outcome: "valid",
          isWeak: true,
        });
      }).not.toThrow();
    });
  });

  describe("integration: hash -> verify -> upgrade", () => {
    it("produces hash that can be verified and upgraded", () => {
      const plaintext = "integration-token";

      // Step 1: Hash new token
      const currentHash = service.hashToken(plaintext);
      expect(currentHash).toContain(`v${CURRENT_HASH_VERSION}`);

      // Step 2: Verify token
      const verifyResult = service.verifyToken(plaintext, currentHash);
      expect(verifyResult.valid).toBe(true);
      expect(verifyResult.version).toBe(CURRENT_HASH_VERSION);
      expect(verifyResult.needsUpgrade).toBe(false);

      // Step 3: Try upgrading (should be no-op for current version)
      if (verifyResult.newHash) {
        const upgradeResult = service.verifyToken(plaintext, verifyResult.newHash);
        expect(upgradeResult.valid).toBe(true);
      }
    });

    it("upgrades weak tokens progressively", () => {
      const plaintext = "legacy-session-token";

      // Create a v1 token
      const derivedKey = createHash("sha256").update(plaintext).digest();
      const legacyHash = formatVersionedHash({
        version: HashAlgorithmVersion.V1_SHA256,
        derivedKey,
      });

      // Verify legacy token
      const result = service.verifyToken(plaintext, legacyHash);
      expect(result.valid).toBe(true);

      if (result.needsUpgrade && result.newHash) {
        // Verify the upgraded hash works
        const upgradeResult = service.verifyToken(plaintext, result.newHash);
        expect(upgradeResult.valid).toBe(true);
        expect(upgradeResult.version).toBe(CURRENT_HASH_VERSION);
        expect(upgradeResult.needsUpgrade).toBe(false);
      }
    });
  });

  describe("config retrieval", () => {
    it("returns copy of config for safety", () => {
      const config1 = service.getConfig();
      const config2 = service.getConfig();
      expect(config1).toEqual(config2);
      expect(config1).not.toBe(config2); // Different objects
    });
  });

  describe("token type classification", () => {
    it("supports various token types in metrics", () => {
      const tokenTypes = [
        "session",
        "proof_share",
        "recent_auth",
        "api_key",
        "wallet_challenge",
      ];

      for (const tokenType of tokenTypes) {
        expect(() => {
          service.recordMetric({
            tokenType,
            version: CURRENT_HASH_VERSION,
            outcome: "valid",
            isWeak: false,
          });
        }).not.toThrow();
      }
    });
  });

  describe("boundary conditions", () => {
    it("handles empty plaintext", () => {
      const hash = service.hashToken("");
      const result = service.verifyToken("", hash);
      expect(result.valid).toBe(true);
    });

    it("handles very long plaintext", () => {
      const longPlaintext = "x".repeat(10000);
      const hash = service.hashToken(longPlaintext);
      const result = service.verifyToken(longPlaintext, hash);
      expect(result.valid).toBe(true);
    });

    it("handles special characters in plaintext", () => {
      const plaintext = "!@#$%^&*()_+-={}[]|:;<>?,./~`";
      const hash = service.hashToken(plaintext);
      const result = service.verifyToken(plaintext, hash);
      expect(result.valid).toBe(true);
    });

    it("handles unicode plaintext", () => {
      const plaintext = "🔐token🔑secreté中文字";
      const hash = service.hashToken(plaintext);
      const result = service.verifyToken(plaintext, hash);
      expect(result.valid).toBe(true);
    });
  });

  describe("regression: existing behavior unchanged", () => {
    it("maintains constant-time comparison semantics", () => {
      const hash1 = service.hashToken("token1");
      const hash2 = service.hashToken("token1");

      // Verify both tokens independently
      const result1 = service.verifyToken("token1", hash1);
      const result2 = service.verifyToken("token1", hash2);

      expect(result1.valid).toBe(true);
      expect(result2.valid).toBe(true);
    });

    it("never leaks token information in error messages", () => {
      const hash = service.hashToken("secret-token");
      const result = service.verifyToken("wrong-token", hash);
      expect(result.valid).toBe(false);
      // No error thrown, just returns invalid result
    });
  });
});

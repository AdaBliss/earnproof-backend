import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { ConfigFingerprintService } from "./config-fingerprint.service";
import { resolveSigningKey } from "../config/config-snapshot";

describe("ConfigFingerprintService", () => {
  let service: ConfigFingerprintService;
  let configService: ConfigService;

  const mockConfig: Record<string, unknown> = {
    nodeEnv: "test",
    port: 4000,
    appUrl: "http://localhost:3000",
    stellar: {
      network: "testnet",
      horizonUrl: "https://horizon-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
    },
    health: {
      probeTimeoutMs: 2000,
      cacheTtlMs: 5000,
    },
  };

  const testSigningKey = resolveSigningKey({
    dedicatedSecret: "test-signing-secret-" + "k".repeat(40),
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConfigFingerprintService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn((key: string, options?: { infer: boolean }) => {
              if (key === "" && options?.infer) {
                return mockConfig;
              }
              if (key === "configRollout.environment") {
                return "test";
              }
              if (key === "configRollout.signingSecret") {
                return testSigningKey?.secret || undefined;
              }
              if (key === "credentialSigningSecret") {
                return "test-credential-signing-secret";
              }
              return undefined;
            }),
            get: jest.fn((key: string) => {
              if (key === "configRollout.signingSecret") {
                return testSigningKey?.secret;
              }
              if (key === "credentialSigningSecret") {
                return "test-credential-signing-secret";
              }
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<ConfigFingerprintService>(ConfigFingerprintService);
    configService = module.get<ConfigService>(ConfigService);
  });

  describe("capturing startup fingerprint", () => {
    it("captures the fingerprint on initialization", () => {
      const fingerprint = service.getFingerprint();
      expect(fingerprint).not.toBeNull();
    });

    it("includes schema version", () => {
      const fingerprint = service.getFingerprint();
      expect(fingerprint?.schema).toBe("earnproof.config-snapshot.v1");
    });

    it("includes environment name", () => {
      const fingerprint = service.getFingerprint();
      expect(fingerprint?.environment).toBe("test");
    });

    it("includes capture timestamp", () => {
      const fingerprint = service.getFingerprint();
      expect(fingerprint?.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("includes content hash", () => {
      const fingerprint = service.getFingerprint();
      expect(fingerprint?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("includes non-secret entries sorted by path", () => {
      const fingerprint = service.getFingerprint();
      expect(fingerprint?.entries.length).toBeGreaterThan(0);
      // Verify sorting
      const paths = fingerprint?.entries.map((e) => e.path) || [];
      const sorted = [...paths].sort();
      expect(paths).toEqual(sorted);
    });

    it("excludes secret-bearing configuration entries", () => {
      const fingerprint = service.getFingerprint();
      const paths = fingerprint?.entries.map((e) => e.path) || [];
      expect(paths).not.toContain("credentialSigningSecret");
    });

    it("records excluded paths with reasons", () => {
      const fingerprint = service.getFingerprint();
      expect(fingerprint?.excluded.length).toBeGreaterThan(0);
      const credentialEntry = fingerprint?.excluded.find(
        (e) => e.path === "credentialSigningSecret",
      );
      expect(credentialEntry).toBeDefined();
      expect(credentialEntry?.reason).toBe("secret_name");
    });

    it("includes HMAC-SHA256 signature", () => {
      const fingerprint = service.getFingerprint();
      expect(fingerprint?.signature.alg).toBe("HMAC-SHA256");
      expect(fingerprint?.signature.keyId).toBe("dedicated");
      expect(fingerprint?.signature.value).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("handling missing or unavailable signing key", () => {
    it("returns null when no signing key is available", async () => {
      const configWithoutKey = {
        provide: ConfigService,
        useValue: {
          getOrThrow: jest.fn((key: string, options?: { infer: boolean }) => {
            if (key === "" && options?.infer) {
              return mockConfig;
            }
            if (key === "configRollout.environment") {
              return "test";
            }
            throw new Error("Config key not found");
          }),
          get: jest.fn(() => undefined),
        },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [ConfigFingerprintService, configWithoutKey],
      }).compile();

      const testService = module.get<ConfigFingerprintService>(ConfigFingerprintService);
      expect(testService.getFingerprint()).toBeNull();
      expect(testService.isCaptureFailed()).toBe(true);
    });
  });

  describe("fingerprint determinism", () => {
    it("produces the same content hash for identical configuration", async () => {
      const module1: TestingModule = await Test.createTestingModule({
        providers: [
          ConfigFingerprintService,
          {
            provide: ConfigService,
            useValue: {
              getOrThrow: jest.fn((key: string, options?: { infer: boolean }) => {
                if (key === "" && options?.infer) {
                  return mockConfig;
                }
                if (key === "configRollout.environment") {
                  return "production";
                }
                if (key === "configRollout.signingSecret") {
                  return testSigningKey?.secret;
                }
                if (key === "credentialSigningSecret") {
                  return "test-credential-signing-secret";
                }
                return undefined;
              }),
              get: jest.fn((key: string) => {
                if (key === "configRollout.signingSecret") {
                  return testSigningKey?.secret;
                }
                if (key === "credentialSigningSecret") {
                  return "test-credential-signing-secret";
                }
                return undefined;
              }),
            },
          },
        ],
      }).compile();

      const service1 = module1.get<ConfigFingerprintService>(ConfigFingerprintService);
      const hash1 = service1.getFingerprint()?.contentHash;

      // Wait slightly to ensure different capturedAt times
      await new Promise((resolve) => setTimeout(resolve, 10));

      const module2: TestingModule = await Test.createTestingModule({
        providers: [
          ConfigFingerprintService,
          {
            provide: ConfigService,
            useValue: {
              getOrThrow: jest.fn((key: string, options?: { infer: boolean }) => {
                if (key === "" && options?.infer) {
                  return mockConfig;
                }
                if (key === "configRollout.environment") {
                  return "production";
                }
                if (key === "configRollout.signingSecret") {
                  return testSigningKey?.secret;
                }
                if (key === "credentialSigningSecret") {
                  return "test-credential-signing-secret";
                }
                return undefined;
              }),
              get: jest.fn((key: string) => {
                if (key === "configRollout.signingSecret") {
                  return testSigningKey?.secret;
                }
                if (key === "credentialSigningSecret") {
                  return "test-credential-signing-secret";
                }
                return undefined;
              }),
            },
          },
        ],
      }).compile();

      const service2 = module2.get<ConfigFingerprintService>(ConfigFingerprintService);
      const hash2 = service2.getFingerprint()?.contentHash;

      // Same configuration should produce the same hash, regardless of capture time
      expect(hash1).toBe(hash2);
    });

    it("binds the hash to the environment", async () => {
      const hash1 = service.getFingerprint()?.contentHash;

      const module2: TestingModule = await Test.createTestingModule({
        providers: [
          ConfigFingerprintService,
          {
            provide: ConfigService,
            useValue: {
              getOrThrow: jest.fn((key: string, options?: { infer: boolean }) => {
                if (key === "" && options?.infer) {
                  return mockConfig;
                }
                if (key === "configRollout.environment") {
                  return "production"; // Different environment
                }
                if (key === "configRollout.signingSecret") {
                  return testSigningKey?.secret;
                }
                if (key === "credentialSigningSecret") {
                  return "test-credential-signing-secret";
                }
                return undefined;
              }),
              get: jest.fn((key: string) => {
                if (key === "configRollout.signingSecret") {
                  return testSigningKey?.secret;
                }
                if (key === "credentialSigningSecret") {
                  return "test-credential-signing-secret";
                }
                return undefined;
              }),
            },
          },
        ],
      }).compile();

      const service2 = module2.get<ConfigFingerprintService>(ConfigFingerprintService);
      const hash2 = service2.getFingerprint()?.contentHash;

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("error handling", () => {
    it("marks capture as failed when configuration retrieval throws", async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ConfigFingerprintService,
          {
            provide: ConfigService,
            useValue: {
              getOrThrow: jest.fn(() => {
                throw new Error("Config service error");
              }),
              get: jest.fn(() => undefined),
            },
          },
        ],
      }).compile();

      const testService = module.get<ConfigFingerprintService>(ConfigFingerprintService);
      expect(testService.getFingerprint()).toBeNull();
      expect(testService.isCaptureFailed()).toBe(true);
    });

    it("does not prevent application startup when capture fails", () => {
      // The service logs errors but does not throw; this is verified by the
      // fact that this test completes without error.
      expect(() => {
        service.getFingerprint();
      }).not.toThrow();
    });
  });

  describe("fingerprint caching", () => {
    it("returns the same fingerprint object on repeated calls", () => {
      const first = service.getFingerprint();
      const second = service.getFingerprint();
      expect(first).toBe(second);
    });

    it("remains valid for the lifetime of the process", () => {
      const fingerprint1 = service.getFingerprint();
      const capturedAt1 = fingerprint1?.capturedAt;

      // Simulate time passing
      jest.useFakeTimers();
      jest.advanceTimersByTime(60_000);

      const fingerprint2 = service.getFingerprint();
      const capturedAt2 = fingerprint2?.capturedAt;

      jest.useRealTimers();

      // Capture time should not change; it's the same object
      expect(capturedAt1).toBe(capturedAt2);
    });
  });
});


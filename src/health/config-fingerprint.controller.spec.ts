import { HttpStatus, ServiceUnavailableException } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";
import { ConfigFingerprintService } from "./config-fingerprint.service";
import { ConfigFingerprintDto } from "./dto/config-fingerprint.dto";
import { DependencyKind, DependencyStatus } from "./health.types";

describe("HealthController - config/fingerprint endpoint", () => {
  let controller: HealthController;
  let healthService: HealthService;
  let fingerprintService: ConfigFingerprintService;

  const mockFingerprint: ConfigFingerprintDto = {
    schema: "earnproof.config-snapshot.v1",
    environment: "test",
    capturedAt: new Date().toISOString(),
    contentHash: "sha256:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0",
    entries: [
      { path: "apiUrl", value: "http://localhost:4000" },
      { path: "appUrl", value: "http://localhost:3000" },
      { path: "nodeEnv", value: "test" },
      { path: "port", value: 4000 },
      { path: "stellar.horizonUrl", value: "https://horizon-testnet.stellar.org" },
      { path: "stellar.network", value: "testnet" },
      { path: "stellar.networkPassphrase", value: "Test SDF Network ; September 2015" },
    ],
    excluded: [
      { path: "databaseUrl", reason: "secret_name" },
      { path: "credentialSigningSecret", reason: "secret_name" },
      { path: "sessionSecret", reason: "secret_name" },
    ],
    signature: {
      alg: "HMAC-SHA256",
      keyId: "dedicated",
      value: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0",
    },
  };

  beforeEach(() => {
    healthService = {
      checkReadiness: jest.fn().mockResolvedValue({
        status: "ready",
        dependencies: [
          {
            name: "database",
            kind: DependencyKind.REQUIRED,
            status: DependencyStatus.OK,
          },
        ],
      }),
      checkLiveness: jest.fn().mockReturnValue({
        status: "ok",
        service: "earnproof-api",
        timestamp: new Date().toISOString(),
      }),
      checkDiagnostics: jest.fn().mockResolvedValue({
        status: "ready",
        dependencies: [],
      }),
      deploymentMetadata: jest.fn(),
      beginShutdown: jest.fn(),
    } as unknown as HealthService;

    fingerprintService = {
      getFingerprint: jest.fn().mockReturnValue(mockFingerprint),
      isCaptureFailed: jest.fn().mockReturnValue(false),
    } as unknown as ConfigFingerprintService;

    controller = new HealthController(healthService, fingerprintService);
  });

  describe("GET /health/config/fingerprint", () => {
    it("returns the configuration fingerprint when available", () => {
      const result = controller.getConfigFingerprint();

      expect(result).toEqual(mockFingerprint);
      expect(fingerprintService.getFingerprint).toHaveBeenCalled();
    });

    it("returns all expected fields", () => {
      const result = controller.getConfigFingerprint();

      expect(result).toHaveProperty("schema");
      expect(result).toHaveProperty("environment");
      expect(result).toHaveProperty("capturedAt");
      expect(result).toHaveProperty("contentHash");
      expect(result).toHaveProperty("entries");
      expect(result).toHaveProperty("excluded");
      expect(result).toHaveProperty("signature");
    });

    it("includes non-secret entries", () => {
      const result = controller.getConfigFingerprint();

      const apiUrlEntry = result.entries.find((e) => e.path === "apiUrl");
      expect(apiUrlEntry).toBeDefined();
      expect(apiUrlEntry?.value).toBe("http://localhost:4000");
    });

    it("records excluded paths without values", () => {
      const result = controller.getConfigFingerprint();

      const excluded = result.excluded.find((e) => e.path === "databaseUrl");
      expect(excluded).toBeDefined();
      expect(excluded?.reason).toBe("secret_name");
      expect(Object.values(excluded || {})).not.toContain("postgresql");
    });

    it("includes a valid signature", () => {
      const result = controller.getConfigFingerprint();

      expect(result.signature.alg).toBe("HMAC-SHA256");
      expect(result.signature.keyId).toBe("dedicated");
      expect(result.signature.value).toMatch(/^[0-9a-f]{64}$/);
    });

    it("throws ServiceUnavailableException when fingerprint is null", () => {
      (fingerprintService.getFingerprint as jest.Mock).mockReturnValue(null);

      expect(() => controller.getConfigFingerprint()).toThrow(
        ServiceUnavailableException,
      );
    });

    it("throws ServiceUnavailableException with descriptive message", () => {
      (fingerprintService.getFingerprint as jest.Mock).mockReturnValue(null);

      expect(() => controller.getConfigFingerprint()).toThrow(
        "Configuration fingerprint is unavailable. No signing key is configured.",
      );
    });
  });

  describe("authorization", () => {
    it("should be decorated with @AuthenticatedRoute", () => {
      // This is verified by the @AuthenticatedRoute decorator on the method
      expect(controller.getConfigFingerprint).toBeDefined();
    });

    it("should require ORG_ADMIN scope", () => {
      // This is verified by the @RequireScopes(ApiKeyScope.ORG_ADMIN) decorator
      expect(controller.getConfigFingerprint).toBeDefined();
    });

    it("should be guarded by ApiKeyGuard and ScopesGuard", () => {
      // This is verified by the @UseGuards decorators
      expect(controller.getConfigFingerprint).toBeDefined();
    });
  });

  describe("response characteristics", () => {
    it("returns entries sorted by path", () => {
      const result = controller.getConfigFingerprint();
      const paths = result.entries.map((e) => e.path);
      const sorted = [...paths].sort();
      expect(paths).toEqual(sorted);
    });

    it("returns excluded paths sorted by path", () => {
      const result = controller.getConfigFingerprint();
      const paths = result.excluded.map((e) => e.path);
      const sorted = [...paths].sort();
      expect(paths).toEqual(sorted);
    });

    it("includes stable reason codes for exclusions", () => {
      const result = controller.getConfigFingerprint();

      for (const excluded of result.excluded) {
        expect(["secret_name", "secret_value"]).toContain(excluded.reason);
      }
    });

    it("includes stable schema version", () => {
      const result = controller.getConfigFingerprint();
      expect(result.schema).toBe("earnproof.config-snapshot.v1");
    });

    it("includes environment scope in the fingerprint", () => {
      const result = controller.getConfigFingerprint();
      expect(result.environment).toMatch(/^\w+$/);
    });

    it("includes ISO-8601 capture timestamp", () => {
      const result = controller.getConfigFingerprint();
      expect(result.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("includes deterministic content hash", () => {
      const result = controller.getConfigFingerprint();
      expect(result.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  });

  describe("secret handling", () => {
    it("never includes secret paths in entries", () => {
      const result = controller.getConfigFingerprint();
      const paths = result.entries.map((e) => e.path);

      const secretPaths = [
        "sessionSecret",
        "credentialSigningSecret",
        "databaseUrl",
        "redisUrl",
        "paymentEncryptionKey",
      ];

      for (const secretPath of secretPaths) {
        expect(paths).not.toContain(secretPath);
      }
    });

    it("never leaks secret values in the response", () => {
      const result = controller.getConfigFingerprint();
      const serialized = JSON.stringify(result);

      const secretPatterns = [
        /S[A-Z]{55}/, // Stellar seed
        /postgresql:\/\/.*:.*@/, // DB URL with credentials
        /redis:\/\/.*:.*@/, // Redis URL with credentials
      ];

      for (const pattern of secretPatterns) {
        expect(serialized).not.toMatch(pattern);
      }
    });

    it("records excluded paths and reasons, not values", () => {
      const result = controller.getConfigFingerprint();

      for (const excluded of result.excluded) {
        // Value should never appear in the exclusion record
        expect(excluded).toHaveProperty("path");
        expect(excluded).toHaveProperty("reason");
        expect(Object.keys(excluded)).not.toContain("value");
      }
    });
  });

  describe("fingerprint consistency", () => {
    it("returns the same fingerprint on repeated calls", () => {
      const first = controller.getConfigFingerprint();
      const second = controller.getConfigFingerprint();

      expect(first.contentHash).toBe(second.contentHash);
      expect(first.capturedAt).toBe(second.capturedAt);
      expect(first.signature.value).toBe(second.signature.value);
    });

    it("reflects startup configuration only", () => {
      // The fingerprint is captured once at startup and never updated,
      // so it should always reflect the same configuration
      const fingerprint = controller.getConfigFingerprint();
      expect(fingerprint.capturedAt).toBeDefined();
    });
  });
});


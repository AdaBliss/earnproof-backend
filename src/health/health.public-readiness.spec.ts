import { ServiceUnavailableException } from "@nestjs/common";
import type { Request } from "express";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";
import {
  DependencyKind,
  DependencyStatus,
  toPublicReadiness,
  type ReadinessResult,
} from "./health.types";

/**
 * Public readiness redaction.
 *
 * `GET /health/ready` is unauthenticated, so its response must reveal only
 * the aggregate verdict plus an opaque correlation reference — never which
 * dependency failed, why, or any diagnostic detail. Every dependency failure
 * shape the service can report is exercised here through a mocked
 * `checkReadiness`, with hostile strings planted in the internal result, to
 * prove none of them can reach an unauthenticated caller through either the
 * 200 body or the 503 exception.
 */

const HOSTILE =
  "postgresql://user:hunter2@db.internal:5432/earnproof " +
  "ECONNREFUSED https://horizon.internal:8000/webhooks " +
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function buildService(
  readiness: ReadinessResult,
  diagnostics: ReadinessResult = { status: "ready", dependencies: [] },
): HealthService {
  return {
    checkLiveness: jest.fn().mockReturnValue({
      status: "ok",
      service: "earnproof-api",
      timestamp: new Date().toISOString(),
    }),
    checkReadiness: jest.fn().mockResolvedValue(readiness),
    checkDiagnostics: jest.fn().mockResolvedValue(diagnostics),
    deploymentMetadata: jest.fn().mockReturnValue({ status: "absent" }),
  } as unknown as HealthService;
}

function requestWith(requestId?: unknown): Request {
  return { requestId } as unknown as Request;
}

async function thrownBy(
  controller: HealthController,
  request: Request,
): Promise<unknown> {
  try {
    await controller.getReadiness(request);
  } catch (error) {
    return error;
  }
  throw new Error("expected getReadiness to throw");
}

describe("public readiness redaction", () => {
  describe("200 ready response", () => {
    it("reveals only the aggregate verdict, service, timestamp, and request ID", async () => {
      const controller = new HealthController(
        buildService({
          status: "ready",
          dependencies: [
            {
              name: "database",
              kind: DependencyKind.REQUIRED,
              status: DependencyStatus.OK,
              durationMs: 12,
              cached: true,
              ageMs: 1200,
            },
            {
              name: "configuration",
              kind: DependencyKind.REQUIRED,
              status: DependencyStatus.OK,
            },
          ],
        }),
      );

      const result = await controller.getReadiness(
        requestWith("9f2c1a7b4e5d4a3b8c6d7e8f90a1b2c3"),
      );

      expect(Object.keys(result).sort()).toEqual([
        "requestId",
        "service",
        "status",
        "timestamp",
      ]);
      expect(result).toMatchObject({
        status: "ready",
        service: "earnproof-api",
        requestId: "9f2c1a7b4e5d4a3b8c6d7e8f90a1b2c3",
      });
      expect(Date.parse(result.timestamp)).not.toBeNaN();
      expect(JSON.stringify(result)).not.toContain("database");
      expect(JSON.stringify(result)).not.toContain("configuration");
    });

    it("omits requestId when the request carried none", async () => {
      const controller = new HealthController(
        buildService({ status: "ready", dependencies: [] }),
      );

      const result = await controller.getReadiness(requestWith(undefined));

      expect(result).not.toHaveProperty("requestId");
    });

    it.each([
      ["injection markup", "<script>alert(1)</script>"],
      ["a value with spaces", "not a request id"],
      ["a value with a newline", "abc\ndef"],
      ["a 129-character value", "a".repeat(129)],
      ["a non-string value", 42],
    ])("does not echo an unsafe request ID (%s)", async (_label, value) => {
      const controller = new HealthController(
        buildService({ status: "ready", dependencies: [] }),
      );

      const result = await controller.getReadiness(requestWith(value));

      expect(result).not.toHaveProperty("requestId");
      if (typeof value === "string") {
        expect(JSON.stringify(result)).not.toContain(value.slice(0, 20));
      }
    });

    it("echoes a 128-character request ID (boundary)", async () => {
      const controller = new HealthController(
        buildService({ status: "ready", dependencies: [] }),
      );
      const id = "a".repeat(128);

      const result = await controller.getReadiness(requestWith(id));

      expect(result.requestId).toBe(id);
    });
  });

  describe("503 not-ready response", () => {
    const failureShapes: Array<{
      label: string;
      readiness: ReadinessResult;
      forbidden: string[];
    }> = [
      {
        label: "database error carrying a DSN and driver code",
        readiness: {
          status: "not_ready",
          dependencies: [
            {
              name: "database",
              kind: DependencyKind.REQUIRED,
              status: DependencyStatus.ERROR,
              reason: HOSTILE,
              durationMs: 2000,
            },
          ],
        },
        forbidden: ["database", "hunter2", "db.internal", "ECONNREFUSED"],
      },
      {
        label: "database timeout",
        readiness: {
          status: "not_ready",
          dependencies: [
            {
              name: "database",
              kind: DependencyKind.REQUIRED,
              status: DependencyStatus.TIMEOUT,
              reason: "probe_timeout",
              durationMs: 2000,
            },
          ],
        },
        forbidden: ["database", "probe_timeout"],
      },
      {
        label: "missing required configuration (key names are internal)",
        readiness: {
          status: "not_ready",
          dependencies: [
            {
              name: "configuration",
              kind: DependencyKind.REQUIRED,
              status: DependencyStatus.ERROR,
              reason:
                "missing_required_config:credentialSigningSecret,databaseUrl,sessionSecret",
            },
          ],
        },
        forbidden: [
          "configuration",
          "credentialSigningSecret",
          "databaseUrl",
          "sessionSecret",
          "missing_required_config",
        ],
      },
      {
        label: "migration deployment in progress",
        readiness: {
          status: "not_ready",
          dependencies: [
            {
              name: "migration_compatibility",
              kind: DependencyKind.REQUIRED,
              status: DependencyStatus.ERROR,
              reason: "migration_in_progress_other_deployment",
            },
          ],
        },
        forbidden: ["migration_compatibility", "migration_in_progress"],
      },
      {
        label: "stale migration lease (degraded)",
        readiness: {
          status: "not_ready",
          dependencies: [
            {
              name: "migration_compatibility",
              kind: DependencyKind.REQUIRED,
              status: DependencyStatus.DEGRADED,
              reason: "stale_migration_lease_detected",
            },
          ],
        },
        forbidden: ["migration_compatibility", "stale_migration_lease"],
      },
      {
        label: "migration compatibility check failure",
        readiness: {
          status: "not_ready",
          dependencies: [
            {
              name: "migration_compatibility",
              kind: DependencyKind.REQUIRED,
              status: DependencyStatus.ERROR,
              reason: "migration_compatibility_check_failed",
            },
          ],
        },
        forbidden: ["migration_compatibility", "migration_compatibility_check_failed"],
      },
      {
        label: "sustained critical clock skew",
        readiness: {
          status: "not_ready",
          dependencies: [
            {
              name: "clock_skew",
              kind: DependencyKind.REQUIRED,
              status: DependencyStatus.ERROR,
              reason: "clock_skew_sustained_critical",
              clockSkew: {
                status: "critical",
                skewMs: 12345,
                source: "horizon-ledger",
                samplesConsidered: 2,
                evaluatedAt: new Date().toISOString(),
                alert: { active: true, severity: "critical", breachStartedAt: null },
                policy: {
                  warnMs: 2000,
                  criticalMs: 10000,
                  unknownPolicy: "fail_open",
                  readinessImpact: "critical",
                },
                sources: [
                  { name: "horizon-ledger", outcome: "ok", skewMs: 12345 },
                ],
              },
            },
          ],
        },
        forbidden: [
          "clock_skew",
          "clock_skew_sustained_critical",
          "horizon-ledger",
          "12345",
        ],
      },
      {
        label: "shutdown in progress",
        readiness: {
          status: "not_ready",
          dependencies: [
            {
              name: "shutdown",
              kind: DependencyKind.REQUIRED,
              status: DependencyStatus.ERROR,
              reason: "shutting_down",
              durationMs: 0,
            },
          ],
        },
        forbidden: ["shutdown", "shutting_down"],
      },
      {
        label: "several required dependencies failing at once",
        readiness: {
          status: "not_ready",
          dependencies: [
            {
              name: "database",
              kind: DependencyKind.REQUIRED,
              status: DependencyStatus.ERROR,
              reason: HOSTILE,
            },
            {
              name: "configuration",
              kind: DependencyKind.REQUIRED,
              status: DependencyStatus.ERROR,
              reason: "missing_required_config:sessionSecret",
            },
            {
              name: "clock_skew",
              kind: DependencyKind.REQUIRED,
              status: DependencyStatus.ERROR,
              reason: "clock_skew_sustained_critical",
            },
          ],
        },
        forbidden: [
          "database",
          "configuration",
          "clock_skew",
          "hunter2",
          "db.internal",
          "sessionSecret",
        ],
      },
    ];

    it.each(failureShapes)(
      "throws a generic 503 for %s",
      async ({ readiness, forbidden }) => {
        const controller = new HealthController(buildService(readiness));

        const thrown = await thrownBy(
          controller,
          requestWith("corr-123"),
        );

        expect(thrown).toBeInstanceOf(ServiceUnavailableException);
        expect((thrown as ServiceUnavailableException).message).toBe(
          "Service is not ready",
        );
        // Serialize the exception's actual payload (its response), not just
        // its enumerable fields, so the check cannot pass vacuously.
        const serialized = JSON.stringify(
          (thrown as ServiceUnavailableException).getResponse(),
        );
        for (const secret of forbidden) {
          expect(serialized).not.toContain(secret);
        }
        expect(serialized).not.toContain("dependencies");
        // The generic message is the whole payload: no topology leaks
        // through an error body, a reason code, or a duration.
        expect(serialized).not.toContain("durationMs");
      },
    );
  });

  describe("diagnostics-only detail stays out of the public probe", () => {
    it("never surfaces optional-dependency failures, even in the ready body", async () => {
      // Horizon down, webhook backlog, a tripped breaker, unconfigured
      // anchoring, a successor not ready: readiness stays ready, and the
      // public body must not even hint these dependencies exist.
      const diagnostics: ReadinessResult = {
        status: "ready",
        dependencies: [
          {
            name: "horizon",
            kind: DependencyKind.OPTIONAL,
            status: DependencyStatus.ERROR,
            reason: "upstream_status_503",
          },
          {
            name: "webhook_delivery",
            kind: DependencyKind.OPTIONAL,
            status: DependencyStatus.DEGRADED,
            reason: "failed_deliveries_present",
          },
          {
            name: "circuit_breakers",
            kind: DependencyKind.OPTIONAL,
            status: DependencyStatus.DEGRADED,
            reason: "tripped:horizon:testnet",
            circuits: [
              {
                name: "horizon:testnet",
                state: "open",
                consecutiveFailures: 3,
                probeSuccesses: 0,
                probesInFlight: 0,
                openCount: 1,
                cooldownRemainingMs: 42000,
              },
            ],
          },
          {
            name: "contract_anchoring",
            kind: DependencyKind.OPTIONAL,
            status: DependencyStatus.NOT_CONFIGURED,
            reason: "proof_registry_contract_id_absent",
          },
          {
            name: "contract_successor_readiness",
            kind: DependencyKind.OPTIONAL,
            status: DependencyStatus.DEGRADED,
            reason: "successor_not_ready_for_migration",
          },
        ],
      };
      const controller = new HealthController(
        buildService({ status: "ready", dependencies: [] }, diagnostics),
      );

      const result = await controller.getReadiness(requestWith("corr-123"));

      expect(result.status).toBe("ready");
      const serialized = JSON.stringify(result);
      for (const name of [
        "horizon",
        "webhook_delivery",
        "circuit_breakers",
        "contract_anchoring",
        "contract_successor_readiness",
        "upstream_status_503",
        "failed_deliveries_present",
      ]) {
        expect(serialized).not.toContain(name);
      }
    });
  });

  describe("authorized diagnostics are unchanged (regression)", () => {
    it("still returns the full per-dependency set to authorized callers", async () => {
      const diagnostics: ReadinessResult = {
        status: "not_ready",
        dependencies: [
          {
            name: "database",
            kind: DependencyKind.REQUIRED,
            status: DependencyStatus.ERROR,
            reason: "probe_failed",
          },
          {
            name: "horizon",
            kind: DependencyKind.OPTIONAL,
            status: DependencyStatus.ERROR,
            reason: "upstream_status_503",
          },
        ],
      };
      const controller = new HealthController(
        buildService({ status: "not_ready", dependencies: [] }, diagnostics),
      );

      await expect(controller.getDiagnostics()).resolves.toEqual(diagnostics);
    });
  });

  describe("other public probes are unchanged (regression)", () => {
    it("legacy /health still returns only its documented fields", async () => {
      const controller = new HealthController(
        buildService({
          status: "ready",
          dependencies: [
            {
              name: "database",
              kind: DependencyKind.REQUIRED,
              status: DependencyStatus.OK,
            },
          ],
        }),
      );

      const result = await controller.getHealth();

      expect(Object.keys(result).sort()).toEqual([
        "database",
        "service",
        "status",
        "timestamp",
      ]);
    });

    it("liveness still answers without consulting readiness", () => {
      const service = buildService({ status: "ready", dependencies: [] });
      const controller = new HealthController(service);

      expect(controller.getLiveness()).toMatchObject({
        status: "ok",
        service: "earnproof-api",
      });
      expect(service.checkReadiness).not.toHaveBeenCalled();
    });
  });

  describe("toPublicReadiness projection", () => {
    it("passes the aggregate verdict through and drops everything else", () => {
      const result = toPublicReadiness(
        {
          status: "not_ready",
          dependencies: [
            {
              name: "database",
              kind: DependencyKind.REQUIRED,
              status: DependencyStatus.ERROR,
              reason: HOSTILE,
              durationMs: 2000,
              cached: true,
              ageMs: 500,
            },
          ],
        },
        "corr-123",
      );

      expect(result.status).toBe("not_ready");
      expect(result.service).toBe("earnproof-api");
      expect(result.requestId).toBe("corr-123");
      expect(Object.keys(result).sort()).toEqual([
        "requestId",
        "service",
        "status",
        "timestamp",
      ]);
      expect(JSON.stringify(result)).not.toContain("hunter2");
    });

    it("is deterministic in shape for ready and not_ready", () => {
      for (const status of ["ready", "not_ready"] as const) {
        const result = toPublicReadiness({ status, dependencies: [] });
        expect(Object.keys(result).sort()).toEqual([
          "service",
          "status",
          "timestamp",
        ]);
      }
    });
  });
});

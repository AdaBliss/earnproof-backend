import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../database/prisma.service";
import type {
  ContractIdentityService,
  ContractIdentityState,
} from "./contract-identity.service";
import { HealthService } from "./health.service";
import { DependencyStatus } from "./health.types";

/** Readiness integration of the contract identity gate (#425). */

function build(state: ContractIdentityState, active = true) {
  const values: Record<string, unknown> = {
    databaseUrl: "postgresql://localhost/earnproof",
    sessionSecret: "session-secret",
    credentialSigningSecret: "signing-secret",
    "health.probeTimeoutMs": 50,
    "health.cacheTtlMs": 0,
  };
  const config = {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([{ "?column?": 1 }]),
  } as unknown as PrismaService;
  const identity = {
    active,
    current: jest.fn(() => state),
  } as unknown as ContractIdentityService;
  return new HealthService(
    prisma,
    config,
    undefined,
    undefined,
    undefined,
    undefined,
    identity,
  );
}

const state = (
  status: ContractIdentityState["status"],
  reasons: ContractIdentityState["reasons"] = [],
): ContractIdentityState => ({ status, reasons, checkedAt: null });

async function identityDependency(service: HealthService) {
  const readiness = await service.checkReadiness();
  return {
    readiness,
    dependency: readiness.dependencies.find((d) => d.name === "contract_identity"),
  };
}

describe("HealthService contract identity gate", () => {
  it("is ready when the identity is verified", async () => {
    const { readiness, dependency } = await identityDependency(build(state("ok")));
    expect(dependency?.status).toBe(DependencyStatus.OK);
    expect(readiness.status).toBe("ready");
  });

  it.each([
    ["pending", state("pending"), "contract_identity_pending"],
    [
      "a wrong network",
      state("mismatch", ["network_passphrase_mismatch"]),
      "network_passphrase_mismatch",
    ],
    ["swapped contracts", state("mismatch", ["contracts_swapped"]), "contracts_swapped"],
    ["an unavailable RPC", state("unavailable", ["rpc_unavailable"]), "rpc_unavailable"],
  ])("is not ready while %s", async (_label, s, reason) => {
    const { readiness, dependency } = await identityDependency(build(s));
    expect(readiness.status).toBe("not_ready");
    expect(dependency).toMatchObject({ status: DependencyStatus.ERROR, reason });
  });

  it("does not gate readiness when the check is inactive", async () => {
    const { readiness, dependency } = await identityDependency(
      build(state("mismatch", ["contracts_swapped"]), false),
    );
    expect(dependency).toBeUndefined();
    expect(readiness.status).toBe("ready");
  });

  it("reports the gate in diagnostics as well", async () => {
    const diagnostics = await build(state("ok")).checkDiagnostics();
    expect(diagnostics.dependencies.map((d) => d.name)).toContain("contract_identity");
  });
});

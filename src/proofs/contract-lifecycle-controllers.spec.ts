import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ApiKeyScope } from "@prisma/client";
import { ContractDecommissionController } from "../contracts/contract-decommission.controller";
import { AuthGuard } from "../common/guards/auth.guard";
import { ApiKeyGuard } from "../common/guards/api-key.guard";
import { ScopesGuard } from "../common/guards/scopes.guard";
import { buildAuthorizationMatrix } from "../common/guards/authorization-policy.registry";
import { PauseAcknowledgementController } from "../health/pause-acknowledgement.controller";
import { ConsentWithdrawalController } from "./consent-withdrawal.controller";
import { ProofActivationAckController } from "./proof-activation-ack.controller";

const REQUIRED_SCOPES_KEY = "requiredScopes";

function guardsOf(target: object, key?: string | symbol): unknown[] {
  const holder = key === undefined ? target : (target as never)[key];
  return Reflect.getMetadata(GUARDS_METADATA, holder) ?? [];
}

describe("new API surfaces: authorization wiring", () => {
  const matrix = buildAuthorizationMatrix([
    ConsentWithdrawalController,
    ProofActivationAckController,
    ContractDecommissionController,
    PauseAcknowledgementController,
  ]);

  it("declares an explicit policy on every route", () => {
    expect(matrix).toHaveLength(8);
    expect(matrix.every(({ policy }) => policy.access)).toBe(true);
  });

  it("requires a session on every subject-facing route", () => {
    expect(guardsOf(ConsentWithdrawalController)).toContain(AuthGuard);
    expect(guardsOf(ProofActivationAckController.prototype, "getEvidence")).toContain(
      AuthGuard,
    );

    const subjectRoutes = matrix.filter(
      ({ controller }) =>
        controller === "ConsentWithdrawalController" ||
        controller === "ProofActivationAckController",
    );
    expect(subjectRoutes.length).toBe(6);
    expect(subjectRoutes.every(({ policy }) => policy.access === "authenticated")).toBe(true);
    expect(subjectRoutes.every(({ policy }) => policy.ownership === "user")).toBe(true);
  });

  it("scopes the decommission policy to an API key with ORG_READ", () => {
    const handler = ContractDecommissionController.prototype.getPolicy;
    expect(guardsOf(ContractDecommissionController.prototype, "getPolicy")).toEqual([
      ApiKeyGuard,
      ScopesGuard,
    ]);
    expect(
      Reflect.getMetadata("scopes", handler) ??
        Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler),
    ).toEqual([ApiKeyScope.ORG_READ]);
  });

  it("exposes only reads on the public pause acknowledgement route", () => {
    const publicRoutes = matrix.filter(({ policy }) => policy.access === "public");
    expect(publicRoutes).toHaveLength(1);
    expect(publicRoutes[0]).toMatchObject({
      controller: "PauseAcknowledgementController",
      httpMethod: "GET",
    });
  });

  it("never lets a subject route accept a user id", () => {
    const paths = matrix.map(({ path }) => path).join("\n");
    expect(paths).not.toMatch(/:userId|:subjectId/);
  });
});

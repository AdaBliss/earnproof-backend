import "reflect-metadata";
import { Test, TestingModule } from "@nestjs/testing";
import { IssuerKeyCompromiseIncidentState } from "@prisma/client";
import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import { IssuerSigningKeysController } from "./issuer-signing-keys.controller";
import { IssuerSigningKeysService } from "./issuer-signing-keys.service";
import { IssuerKeyCompromiseResponseService } from "./issuer-key-compromise-response.service";

describe("IssuerSigningKeysController — compromise endpoints", () => {
  let controller: IssuerSigningKeysController;
  let compromiseService: {
    respondToCompromise: jest.Mock;
    getIncident: jest.Mock;
    listIncidents: jest.Mock;
    resolveIncident: jest.Mock;
  };

  const adminUser = {
    id: "user-admin-1",
    walletAddress: "GADMINWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    walletHash: "sha256:admin",
    role: "ADMIN",
    organizationId: "org-1",
  };

  const incident = {
    id: "incident-1",
    issuerId: "issuer-1",
    keyId: "key-1",
    state: IssuerKeyCompromiseIncidentState.OPEN,
    reason: "Issuer reported a suspected leak.",
    compromisedAt: "2026-11-19T12:00:00.000Z",
    trustPinsRevoked: 2,
    affectedQuarantines: 0,
    affectedProofs: 0,
    discoveryTruncated: false,
    evidenceHash: null,
    containedAt: null,
    resolvedAt: null,
    resolutionNote: null,
    notificationId: "notification-1",
    contractReconciledAt: null,
    createdAt: "2026-11-19T12:00:00.000Z",
  };

  beforeEach(async () => {
    compromiseService = {
      respondToCompromise: jest.fn().mockResolvedValue(incident),
      getIncident: jest.fn().mockResolvedValue(incident),
      listIncidents: jest.fn().mockResolvedValue([incident]),
      resolveIncident: jest.fn().mockResolvedValue({
        ...incident,
        state: IssuerKeyCompromiseIncidentState.RESOLVED,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [IssuerSigningKeysController],
      providers: [
        {
          provide: IssuerSigningKeysService,
          useValue: {
            listKeys: jest.fn(),
            registerKey: jest.fn(),
            retireKey: jest.fn(),
          },
        },
        {
          provide: IssuerKeyCompromiseResponseService,
          useValue: compromiseService,
        },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: jest.fn(() => true) })
      .overrideGuard(RoleGuard)
      .useValue({ canActivate: jest.fn(() => true) })
      .compile();

    controller = module.get<IssuerSigningKeysController>(
      IssuerSigningKeysController,
    );
  });

  it("compromise delegates to the response service with the user and reason", async () => {
    const result = await controller.compromiseKey(
      adminUser,
      "issuer-1",
      "key-1",
      { reason: "Issuer reported a suspected leak." },
    );

    expect(compromiseService.respondToCompromise).toHaveBeenCalledWith({
      issuerId: "issuer-1",
      keyId: "key-1",
      actorId: "user-admin-1",
      organizationId: "org-1",
      reason: "Issuer reported a suspected leak.",
    });
    expect(result).toBe(incident);
  });

  it("getCompromiseIncident delegates with the caller's organization", async () => {
    const result = await controller.getCompromiseIncident(
      adminUser,
      "issuer-1",
      "key-1",
    );

    expect(compromiseService.getIncident).toHaveBeenCalledWith(
      "issuer-1",
      "key-1",
      "org-1",
    );
    expect(result).toBe(incident);
  });

  it("listCompromiseIncidents delegates with the query", async () => {
    const result = await controller.listCompromiseIncidents(
      adminUser,
      "issuer-1",
      {
        state: IssuerKeyCompromiseIncidentState.OPEN,
        limit: 10,
      },
    );

    expect(compromiseService.listIncidents).toHaveBeenCalledWith(
      "issuer-1",
      "org-1",
      { state: IssuerKeyCompromiseIncidentState.OPEN, limit: 10 },
    );
    expect(result).toEqual([incident]);
  });

  it("resolve loads the incident for the key, then resolves it with the note", async () => {
    const result = await controller.resolveCompromiseIncident(
      adminUser,
      "issuer-1",
      "key-1",
      { note: "Replacement key verified." },
    );

    expect(compromiseService.getIncident).toHaveBeenCalledWith(
      "issuer-1",
      "key-1",
      "org-1",
    );
    expect(compromiseService.resolveIncident).toHaveBeenCalledWith({
      incidentId: "incident-1",
      actorId: "user-admin-1",
      organizationId: "org-1",
      note: "Replacement key verified.",
    });
    expect(result.state).toBe(IssuerKeyCompromiseIncidentState.RESOLVED);
  });

  it("requires ADMIN for the compromise route", () => {
    const requiredRole = Reflect.getMetadata(
      "requiredRole",
      IssuerSigningKeysController.prototype.compromiseKey,
    );
    expect(requiredRole).toBe("ADMIN");
  });

  it("requires ADMIN for the resolve route", () => {
    const requiredRole = Reflect.getMetadata(
      "requiredRole",
      IssuerSigningKeysController.prototype.resolveCompromiseIncident,
    );
    expect(requiredRole).toBe("ADMIN");
  });

  it("does not require a role for the read routes", () => {
    expect(
      Reflect.getMetadata(
        "requiredRole",
        IssuerSigningKeysController.prototype.getCompromiseIncident,
      ),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(
        "requiredRole",
        IssuerSigningKeysController.prototype.listCompromiseIncidents,
      ),
    ).toBeUndefined();
  });
});

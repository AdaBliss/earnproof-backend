import { IssuerAssuranceLevel, ResourceStatus } from "@prisma/client";
import {
  IssuerRegistryService,
  parseIssuerAddress,
  parseIssuerAssurance,
} from "./issuer-registry.service";

describe("IssuerRegistryService", () => {
  const input = {
    issuerId: "issuer_1",
    stellarAddress: "GBFXVVSIVZHCSLMZ23N7QDOSFKMCXFQZ7S3KBXCGYZTZZBDSJ2SPCZYZ",
    metadataHash: "a".repeat(64),
    status: ResourceStatus.ACTIVE,
    contractSyncedStatus: null,
  };

  it("reports PENDING before an issuer is approved", async () => {
    const service = new IssuerRegistryService({
      get: jest.fn(),
    } as never);

    await expect(
      service.sync({ ...input, status: ResourceStatus.PENDING }),
    ).resolves.toEqual({
      state: "pending",
      reason: "Issuer must be ACTIVE before contract registration",
    });
  });

  it("reports DISABLED when the registry is not fully configured", async () => {
    const service = new IssuerRegistryService({
      get: jest.fn(),
    } as never);

    await expect(service.sync(input)).resolves.toEqual({
      state: "disabled",
      reason: "Issuer registry synchronization is not configured",
    });
  });
});

describe("IssuerRegistryService address rotation", () => {
  const issuerAddress = "GBFXVVSIVZHCSLMZ23N7QDOSFKMCXFQZ7S3KBXCGYZTZZBDSJ2SPCZYZ";
  const newAddress = "GCFXVVSIVZHCSLMZ23N7QDOSFKMCXFQZ7S3KBXCGYZTZZBDSJ2SPCZYA";

  class ScriptedRegistry extends IssuerRegistryService {
    calls: string[][] = [];
    constructor(private readonly respond: (args: string[]) => string) {
      super({
        get: (key: string) =>
          ({
            "issuerRegistry.enabled": true,
            "issuerRegistry.source": "registry-admin",
            "issuerRegistry.contractId": "CCONTRACT",
            "stellar.network": "testnet",
          })[key],
      } as never);
    }
    protected async execute(args: string[]): Promise<string> {
      this.calls.push(args);
      return this.respond(args);
    }
  }

  it("reads the address the contract holds, without signing", async () => {
    const registry = new ScriptedRegistry(() =>
      JSON.stringify({ issuer_address: issuerAddress, status: "Active" }),
    );

    await expect(registry.readIssuerAddress("issuer_1")).resolves.toEqual({
      state: "found",
      issuerAddress,
    });
    expect(registry.calls[0]).toEqual([
      "contract",
      "invoke",
      "--network",
      "testnet",
      "--id",
      "CCONTRACT",
      "--",
      "get_issuer",
      "--issuer_id_hash",
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
    expect(registry.calls[0]).not.toContain("--source");
  });

  it("submits rotate_issuer_address signed by the registry source", async () => {
    const registry = new ScriptedRegistry(() => `simulating...\n${"e".repeat(64)}\n`);

    await expect(registry.rotateIssuerAddress("issuer_1", newAddress)).resolves.toEqual({
      state: "submitted",
      transactionHash: "e".repeat(64),
    });
    expect(registry.calls[0]).toEqual(
      expect.arrayContaining([
        "--source",
        "registry-admin",
        "rotate_issuer_address",
        "--new_address",
        newAddress,
      ]),
    );
  });

  it("reports a failed CLI call instead of throwing, with a redacted message", async () => {
    const registry = new ScriptedRegistry(() => {
      throw new Error("Error(Contract, #7): address already registered");
    });

    const read = await registry.readIssuerAddress("issuer_1");
    const rotate = await registry.rotateIssuerAddress("issuer_1", newAddress);

    expect(read.state).toBe("failed");
    expect(rotate.state).toBe("failed");
  });

  it("treats output without an issuer address as a failed read", async () => {
    const registry = new ScriptedRegistry(() => "null");

    await expect(registry.readIssuerAddress("issuer_1")).resolves.toMatchObject({
      state: "failed",
    });
  });

  it("is disabled until the contract, source and flag are all configured", async () => {
    const registry = new IssuerRegistryService({ get: jest.fn() } as never);

    expect(registry.isConfigured).toBe(false);
    await expect(registry.readIssuerAddress("issuer_1")).resolves.toMatchObject({
      state: "disabled",
    });
    await expect(registry.rotateIssuerAddress("issuer_1", newAddress)).resolves.toMatchObject({
      state: "disabled",
    });
  });

  it.each([
    [JSON.stringify({ issuer_address: issuerAddress }), issuerAddress],
    [`{ issuer_address: "${issuerAddress}", status: Active }`, issuerAddress],
    ["{}", undefined],
    ["", undefined],
  ])("parses %p", (stdout, expected) => {
    expect(parseIssuerAddress(stdout)).toBe(expected);
  });
});

describe("IssuerRegistryService assurance reads", () => {
  const issuerAddress = "GBFXVVSIVZHCSLMZ23N7QDOSFKMCXFQZ7S3KBXCGYZTZZBDSJ2SPCZYZ";

  class ScriptedRegistry extends IssuerRegistryService {
    calls: string[][] = [];
    constructor(private readonly respond: (args: string[]) => string) {
      super({
        get: (key: string) =>
          ({
            "issuerRegistry.enabled": true,
            "issuerRegistry.source": "registry-admin",
            "issuerRegistry.contractId": "CCONTRACT",
            "stellar.network": "testnet",
          })[key],
      } as never);
    }
    protected async execute(args: string[]): Promise<string> {
      this.calls.push(args);
      return this.respond(args);
    }
  }

  it("reads assurance and expiry from the contract record, with provenance", async () => {
    const registry = new ScriptedRegistry(() =>
      JSON.stringify({
        issuer_address: issuerAddress,
        assurance_level: "STANDARD",
        accreditation_expires_at: "2027-01-01T00:00:00.000Z",
      }),
    );

    const result = await registry.readIssuerAssurance("issuer_1");

    expect(result).toEqual({
      state: "found",
      issuerAddress,
      assuranceLevel: IssuerAssuranceLevel.STANDARD,
      accreditationExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
      contractId: "CCONTRACT",
      network: "testnet",
      observedAt: expect.any(Date),
    });
    // Same read-only get_issuer call as the address read: no signing source.
    expect(registry.calls[0]).toEqual([
      "contract",
      "invoke",
      "--network",
      "testnet",
      "--id",
      "CCONTRACT",
      "--",
      "get_issuer",
      "--issuer_id_hash",
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
    expect(registry.calls[0]).not.toContain("--source");
  });

  it("treats a missing expiry as a perpetual accreditation, not an absence", async () => {
    const registry = new ScriptedRegistry(() =>
      JSON.stringify({
        issuer_address: issuerAddress,
        assurance_level: "ENHANCED",
      }),
    );

    await expect(registry.readIssuerAssurance("issuer_1")).resolves.toEqual(
      expect.objectContaining({
        state: "found",
        assuranceLevel: IssuerAssuranceLevel.ENHANCED,
        accreditationExpiresAt: null,
      }),
    );
  });

  it("accepts an epoch-seconds expiry", async () => {
    const registry = new ScriptedRegistry(() =>
      JSON.stringify({
        issuer_address: issuerAddress,
        assurance_level: "BASIC",
        accreditation_expires_at: 1798761600,
      }),
    );

    await expect(registry.readIssuerAssurance("issuer_1")).resolves.toEqual(
      expect.objectContaining({
        state: "found",
        assuranceLevel: IssuerAssuranceLevel.BASIC,
        accreditationExpiresAt: new Date(1798761600 * 1_000),
      }),
    );
  });

  it("is disabled until the contract, source and flag are all configured", async () => {
    const registry = new IssuerRegistryService({ get: jest.fn() } as never);

    await expect(registry.readIssuerAssurance("issuer_1")).resolves.toMatchObject({
      state: "disabled",
    });
  });

  it("reports a failed CLI call instead of throwing", async () => {
    const registry = new ScriptedRegistry(() => {
      throw new Error("Error(Contract, #7): issuer not found");
    });

    await expect(registry.readIssuerAssurance("issuer_1")).resolves.toMatchObject({
      state: "failed",
    });
  });

  it("fails the read when the contract record carries no assurance level", async () => {
    const registry = new ScriptedRegistry(() =>
      JSON.stringify({ issuer_address: issuerAddress }),
    );

    await expect(registry.readIssuerAssurance("issuer_1")).resolves.toMatchObject({
      state: "failed",
    });
  });

  it("fails the read on an unrecognized assurance level instead of guessing", async () => {
    const registry = new ScriptedRegistry(() =>
      JSON.stringify({
        issuer_address: issuerAddress,
        assurance_level: "PLATINUM",
        accreditation_expires_at: "2027-01-01T00:00:00.000Z",
      }),
    );

    await expect(registry.readIssuerAssurance("issuer_1")).resolves.toMatchObject({
      state: "failed",
    });
  });

  it("fails the read on an unparseable expiry instead of guessing", async () => {
    const registry = new ScriptedRegistry(() =>
      JSON.stringify({
        issuer_address: issuerAddress,
        assurance_level: "STANDARD",
        accreditation_expires_at: "not-a-date",
      }),
    );

    await expect(registry.readIssuerAssurance("issuer_1")).resolves.toMatchObject({
      state: "failed",
    });
  });

  it.each([
    [
      JSON.stringify({
        issuer_address: issuerAddress,
        assurance_level: "standard",
        accreditation_expires_at: "2027-01-01T00:00:00.000Z",
      }),
      {
        issuerAddress,
        assuranceLevel: IssuerAssuranceLevel.STANDARD,
        accreditationExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
      },
    ],
    [
      JSON.stringify({
        issuer_address: issuerAddress,
        assurance_level: "NONE",
      }),
      {
        issuerAddress,
        assuranceLevel: IssuerAssuranceLevel.NONE,
        accreditationExpiresAt: null,
      },
    ],
    [JSON.stringify({ issuer_address: issuerAddress }), undefined],
    [
      JSON.stringify({
        issuer_address: issuerAddress,
        assurance_level: "GOLD",
      }),
      undefined,
    ],
    [
      JSON.stringify({
        issuer_address: issuerAddress,
        assurance_level: "STANDARD",
        accreditation_expires_at: "yesterday",
      }),
      undefined,
    ],
    ["{}", undefined],
    ["", undefined],
  ])("parses assurance %p", (stdout, expected) => {
    expect(parseIssuerAssurance(stdout)).toEqual(expected);
  });
});

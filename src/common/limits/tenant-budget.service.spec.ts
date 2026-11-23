import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { TenantBudgetService } from "./tenant-budget.service";
import { AcquireRequest } from "./tenant-budget.types";

describe("TenantBudgetService", () => {
  let service: TenantBudgetService;

  const mockConfigService = {
    get: (key: string, defaultValue?: any) => {
      const config: any = {
        "tenantBudget.normalLimit": 100,
        "tenantBudget.reservedLimit": 20,
        "tenantBudget.leaseTtlMs": 30_000,
        "tenantBudget.maxQueueDepth": 50,
        "tenantBudget.maxQueueWaitMs": 5_000,
      };
      return config[key] ?? defaultValue;
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantBudgetService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<TenantBudgetService>(TenantBudgetService);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it("should admit first request for a tenant", async () => {
    const request: AcquireRequest = {
      tenantId: "tenant1",
      operationClass: "read",
      weight: 5,
      isSecurityOperation: false,
    };

    const result = await service.acquire(request);

    expect(result.admitted).toBe(true);
    expect(result.lease).toBeDefined();
    expect(result.lease?.weight).toBe(5);
  });

  it("should admit multiple requests within budget", async () => {
    const tenantId = "tenant1";
    const leases = [];

    for (let i = 0; i < 10; i++) {
      const result = await service.acquire({
        tenantId,
        operationClass: "read",
        weight: 5,
        isSecurityOperation: false,
      });
      expect(result.admitted).toBe(true);
      leases.push(result.lease!);
    }

    const snapshot = service.snapshot(tenantId);
    expect(snapshot.normalInFlightWeight).toBe(50);
  });

  it("should isolate budgets per tenant", async () => {
    const tenant1 = "tenant1";
    const tenant2 = "tenant2";

    const r1 = await service.acquire({
      tenantId: tenant1,
      operationClass: "read",
      weight: 100,
      isSecurityOperation: false,
    });
    expect(r1.admitted).toBe(true);

    const r2 = await service.acquire({
      tenantId: tenant2,
      operationClass: "read",
      weight: 100,
      isSecurityOperation: false,
    });
    expect(r2.admitted).toBe(true);

    const snap1 = service.snapshot(tenant1);
    const snap2 = service.snapshot(tenant2);
    expect(snap1.normalInFlightWeight).toBe(100);
    expect(snap2.normalInFlightWeight).toBe(100);
  });

  it("should admit security operations in reserved lane", async () => {
    const tenantId = "tenant1";

    const r1 = await service.acquire({
      tenantId,
      operationClass: "write",
      weight: 100,
      isSecurityOperation: false,
    });
    expect(r1.admitted).toBe(true);

    const r2 = await service.acquire({
      tenantId,
      operationClass: "security:auth",
      weight: 5,
      isSecurityOperation: true,
    });
    expect(r2.admitted).toBe(true);

    const snapshot = service.snapshot(tenantId);
    expect(snapshot.normalInFlightWeight).toBe(100);
    expect(snapshot.reservedInFlightWeight).toBe(5);
  });

  it("should release lease correctly", async () => {
    const tenantId = "tenant1";

    const r1 = await service.acquire({
      tenantId,
      operationClass: "read",
      weight: 50,
      isSecurityOperation: false,
    });
    expect(r1.admitted).toBe(true);

    let snapshot = service.snapshot(tenantId);
    expect(snapshot.normalInFlightWeight).toBe(50);

    await r1.lease!.release();

    snapshot = service.snapshot(tenantId);
    expect(snapshot.normalInFlightWeight).toBe(0);
  });

  it("should reject when queue is full", async () => {
    const tenantId = "tenant1";

    const r1 = await service.acquire({
      tenantId,
      operationClass: "read",
      weight: 100,
      isSecurityOperation: false,
    });
    expect(r1.admitted).toBe(true);

    const queuePromises = [];
    for (let i = 0; i < 50; i++) {
      queuePromises.push(
        service.acquire({
          tenantId,
          operationClass: "read",
          weight: 5,
          isSecurityOperation: false,
        }),
      );
    }

    const result = await service.acquire({
      tenantId,
      operationClass: "read",
      weight: 5,
      isSecurityOperation: false,
    });
    expect(result.admitted).toBe(false);
    expect(result.rejectionReason).toBe("queue_full");
  });

  it("should sum weights correctly", async () => {
    const tenantId = "tenant1";

    const r1 = await service.acquire({
      tenantId,
      operationClass: "read",
      weight: 10,
      isSecurityOperation: false,
    });
    const r2 = await service.acquire({
      tenantId,
      operationClass: "write",
      weight: 20,
      isSecurityOperation: false,
    });
    const r3 = await service.acquire({
      tenantId,
      operationClass: "contract",
      weight: 30,
      isSecurityOperation: false,
    });

    expect(r1.admitted && r2.admitted && r3.admitted).toBe(true);
    const snapshot = service.snapshot(tenantId);
    expect(snapshot.normalInFlightWeight).toBe(60);
  });

  it("should admit request exactly at limit", async () => {
    const tenantId = "tenant1";
    const result = await service.acquire({
      tenantId,
      operationClass: "read",
      weight: 100,
      isSecurityOperation: false,
    });
    expect(result.admitted).toBe(true);
  });

  it("should not admit request one over limit", async () => {
    const tenantId = "tenant1";

    const r1 = await service.acquire({
      tenantId,
      operationClass: "read",
      weight: 100,
      isSecurityOperation: false,
    });
    expect(r1.admitted).toBe(true);

    const canAdmit = service.canAdmit(tenantId, 1, false);
    expect(canAdmit).toBe(false);
  });

  it("should respect reserved lane limit", async () => {
    const tenantId = "tenant1";

    const results = [];
    for (let i = 0; i < 20; i++) {
      const r = await service.acquire({
        tenantId,
        operationClass: "security:auth",
        weight: 1,
        isSecurityOperation: true,
      });
      results.push(r);
    }

    expect(results.every((r) => r.admitted)).toBe(true);

    const canAdmit = service.canAdmit(tenantId, 1, true);
    expect(canAdmit).toBe(false);
  });

  it("should handle concurrent requests correctly", async () => {
    const tenantId = "tenant_concurrent";
    const promises = [];

    for (let i = 0; i < 20; i++) {
      promises.push(
        service.acquire({
          tenantId,
          operationClass: "read",
          weight: 5,
          isSecurityOperation: false,
        }),
      );
    }

    const results = await Promise.all(promises);
    const admitted = results.filter((r) => r.admitted).length;

    expect(admitted).toBe(20);

    const snapshot = service.snapshot(tenantId);
    expect(snapshot.normalInFlightWeight).toBe(100);
  });

  it("should not leak cross-tenant usage", async () => {
    const tenant1 = "tenant1";
    const tenant2 = "tenant2";

    await service.acquire({
      tenantId: tenant1,
      operationClass: "read",
      weight: 50,
      isSecurityOperation: false,
    });

    await service.acquire({
      tenantId: tenant2,
      operationClass: "read",
      weight: 75,
      isSecurityOperation: false,
    });

    const snap1 = service.snapshot(tenant1);
    const snap2 = service.snapshot(tenant2);

    expect(snap1.normalInFlightWeight).toBe(50);
    expect(snap2.normalInFlightWeight).toBe(75);

    const snap3 = service.snapshot("tenant3");
    expect(snap3.normalInFlightWeight).toBe(0);
  });
});

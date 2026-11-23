import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AcquireRequest,
  AcquireResult,
  BudgetLease,
  BudgetObservation,
  OperationClass,
  TenantBudgetConfig,
  TenantBudgetSnapshot,
  TenantWeightConfig,
} from "./tenant-budget.types";

interface TenantState {
  normalInFlightWeight: number;
  reservedInFlightWeight: number;
  queue: Array<{
    request: AcquireRequest;
    resolveWith: (lease: BudgetLease | null) => void;
    rejectWith: (reason: string) => void;
    enqueuedAtMs: number;
  }>;
  leases: Map<string, { weight: number; isReserved: boolean; expiresAtMs: number }>;
}

const DEFAULT_CONFIG: TenantBudgetConfig = {
  normalLimit: 100,
  reservedLimit: 20,
  leaseTtlMs: 30_000,
  maxQueueDepth: 50,
  maxQueueWaitMs: 5_000,
} as const;

const DEFAULT_WEIGHTS: TenantWeightConfig = {
  "security:auth": 1,
  "security:revocation": 1,
  "security:key-rotation": 1,
  "security:session-invalidation": 1,
  read: 2,
  write: 5,
  contract: 15,
} as const;

@Injectable()
export class TenantBudgetService {
  private readonly logger = new Logger(TenantBudgetService.name);
  private readonly budgetConfig: TenantBudgetConfig;
  private readonly weightConfig: TenantWeightConfig;
  private readonly tenants = new Map<string, TenantState>();
  private readonly observations: BudgetObservation[] = [];
  private readonly leaseCounter = { value: 0 };
  private readonly cleanupIntervalHandle: NodeJS.Timer;

  constructor(private readonly configService: ConfigService) {
    this.budgetConfig = this.loadBudgetConfig();
    this.weightConfig = this.loadWeightConfig();
    this.cleanupIntervalHandle = setInterval(() => this.expireLeases(), 5_000);
  }

  async onModuleDestroy() {
    clearInterval(this.cleanupIntervalHandle);
  }

  async acquire(request: AcquireRequest): Promise<AcquireResult> {
    const tenant = this.getOrCreateTenant(request.tenantId);
    const weight = request.weight;

    const canAdmit = this.canAdmit(
      request.tenantId,
      weight,
      request.isSecurityOperation,
    );

    if (canAdmit) {
      const lease = await this.issueLease(
        request.tenantId,
        weight,
        request.isSecurityOperation,
      );
      this.recordObservation({
        tenantId: request.tenantId,
        operationClass: request.operationClass,
        weight,
        isSecurityOperation: request.isSecurityOperation,
        outcome: "admitted",
        timestampMs: Date.now(),
      });
      return { lease, admitted: true };
    }

    if (tenant.queue.length >= this.budgetConfig.maxQueueDepth) {
      this.recordObservation({
        tenantId: request.tenantId,
        operationClass: request.operationClass,
        weight,
        isSecurityOperation: request.isSecurityOperation,
        outcome: "rejected",
        rejectionReason: "queue_full",
        timestampMs: Date.now(),
      });
      return {
        lease: null,
        admitted: false,
        rejectionReason: "queue_full",
        retryAfterSeconds: 30,
      };
    }

    return new Promise((resolveWith, rejectWith) => {
      const enqueuedAtMs = Date.now();
      tenant.queue.push({ request, resolveWith, rejectWith, enqueuedAtMs });

      const timeoutHandle = setTimeout(() => {
        const idx = tenant.queue.findIndex((q) => q.enqueuedAtMs === enqueuedAtMs);
        if (idx >= 0) {
          tenant.queue.splice(idx, 1);
          this.recordObservation({
            tenantId: request.tenantId,
            operationClass: request.operationClass,
            weight,
            isSecurityOperation: request.isSecurityOperation,
            outcome: "rejected",
            rejectionReason: "queue_wait_expired",
            queuedDurationMs: Date.now() - enqueuedAtMs,
            timestampMs: Date.now(),
          });
          rejectWith("queue_wait_expired");
        }
      }, this.budgetConfig.maxQueueWaitMs);

      this.tryDequeueOne(request.tenantId, timeoutHandle);
    });
  }

  canAdmit(tenantId: string, weight: number, isSecurityOperation: boolean): boolean {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return true;

    if (isSecurityOperation) {
      return (
        tenant.reservedInFlightWeight + weight <= this.budgetConfig.reservedLimit
      );
    }
    return (
      tenant.normalInFlightWeight + weight <= this.budgetConfig.normalLimit
    );
  }

  snapshot(tenantId: string): TenantBudgetSnapshot {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      return {
        tenantId,
        normalInFlightWeight: 0,
        reservedInFlightWeight: 0,
        queueDepth: 0,
      };
    }

    return {
      tenantId,
      normalInFlightWeight: tenant.normalInFlightWeight,
      reservedInFlightWeight: tenant.reservedInFlightWeight,
      queueDepth: tenant.queue.length,
      oldestQueuedAtMs:
        tenant.queue.length > 0 ? tenant.queue[0].enqueuedAtMs : undefined,
    };
  }

  getObservations(limit: number = 1000): BudgetObservation[] {
    return this.observations.slice(-limit);
  }

  private async issueLease(
    tenantId: string,
    weight: number,
    isReserved: boolean,
  ): Promise<BudgetLease> {
    const tenant = this.getOrCreateTenant(tenantId);
    const leaseId = `lease_${++this.leaseCounter.value}`;
    const acquiredAtMs = Date.now();
    const expiresAtMs = acquiredAtMs + this.budgetConfig.leaseTtlMs;

    if (isReserved) {
      tenant.reservedInFlightWeight += weight;
    } else {
      tenant.normalInFlightWeight += weight;
    }

    tenant.leases.set(leaseId, { weight, isReserved, expiresAtMs });

    const release = async () => {
      const lease = tenant.leases.get(leaseId);
      if (!lease) return;

      tenant.leases.delete(leaseId);
      if (lease.isReserved) {
        tenant.reservedInFlightWeight -= lease.weight;
      } else {
        tenant.normalInFlightWeight -= lease.weight;
      }

      this.tryDequeueOne(tenantId);
    };

    return { leaseId, tenantId, weight, acquiredAtMs, expiresAtMs, release };
  }

  private tryDequeueOne(tenantId: string, timeoutHandle?: NodeJS.Timeout) {
    const tenant = this.tenants.get(tenantId);
    if (!tenant || tenant.queue.length === 0) return;

    const { request, resolveWith, rejectWith, enqueuedAtMs } = tenant.queue[0];

    if (this.canAdmit(tenantId, request.weight, request.isSecurityOperation)) {
      tenant.queue.shift();
      if (timeoutHandle) clearTimeout(timeoutHandle);

      this.issueLease(
        tenantId,
        request.weight,
        request.isSecurityOperation,
      ).then((lease) => {
        const queuedDurationMs = Date.now() - enqueuedAtMs;
        this.recordObservation({
          tenantId,
          operationClass: request.operationClass,
          weight: request.weight,
          isSecurityOperation: request.isSecurityOperation,
          outcome: "admitted",
          queuedDurationMs,
          timestampMs: Date.now(),
        });
        resolveWith(lease);
      });
    }
  }

  private expireLeases() {
    const now = Date.now();
    for (const [tenantId, tenant] of this.tenants.entries()) {
      const expired: string[] = [];
      for (const [leaseId, lease] of tenant.leases.entries()) {
        if (lease.expiresAtMs <= now) {
          expired.push(leaseId);
        }
      }

      for (const leaseId of expired) {
        const lease = tenant.leases.get(leaseId);
        if (lease) {
          tenant.leases.delete(leaseId);
          if (lease.isReserved) {
            tenant.reservedInFlightWeight -= lease.weight;
          } else {
            tenant.normalInFlightWeight -= lease.weight;
          }
          this.logger.warn(
            `Lease ${leaseId} (tenant ${tenantId}) auto-expired`,
          );
        }
      }

      if (expired.length > 0) {
        this.tryDequeueOne(tenantId);
      }
    }
  }

  private getOrCreateTenant(tenantId: string): TenantState {
    if (!this.tenants.has(tenantId)) {
      this.tenants.set(tenantId, {
        normalInFlightWeight: 0,
        reservedInFlightWeight: 0,
        queue: [],
        leases: new Map(),
      });
    }
    return this.tenants.get(tenantId)!;
  }

  private loadBudgetConfig(): TenantBudgetConfig {
    const normalLimit = this.configService.get<number>(
      "tenantBudget.normalLimit",
    );
    const reservedLimit = this.configService.get<number>(
      "tenantBudget.reservedLimit",
    );
    const leaseTtlMs = this.configService.get<number>("tenantBudget.leaseTtlMs");
    const maxQueueDepth = this.configService.get<number>(
      "tenantBudget.maxQueueDepth",
    );
    const maxQueueWaitMs = this.configService.get<number>(
      "tenantBudget.maxQueueWaitMs",
    );

    return {
      normalLimit:
        normalLimit && normalLimit > 0 ? normalLimit : DEFAULT_CONFIG.normalLimit,
      reservedLimit:
        reservedLimit && reservedLimit > 0
          ? reservedLimit
          : DEFAULT_CONFIG.reservedLimit,
      leaseTtlMs:
        leaseTtlMs && leaseTtlMs > 0 ? leaseTtlMs : DEFAULT_CONFIG.leaseTtlMs,
      maxQueueDepth:
        maxQueueDepth && maxQueueDepth > 0
          ? maxQueueDepth
          : DEFAULT_CONFIG.maxQueueDepth,
      maxQueueWaitMs:
        maxQueueWaitMs && maxQueueWaitMs > 0
          ? maxQueueWaitMs
          : DEFAULT_CONFIG.maxQueueWaitMs,
    };
  }

  private loadWeightConfig(): TenantWeightConfig {
    const custom = this.configService.get<TenantWeightConfig>(
      "tenantBudget.weights",
    );
    return custom && typeof custom === "object" ? custom : DEFAULT_WEIGHTS;
  }

  private recordObservation(obs: BudgetObservation) {
    this.observations.push(obs);
    if (this.observations.length > 10_000) {
      this.observations.splice(0, this.observations.length - 10_000);
    }
  }
}

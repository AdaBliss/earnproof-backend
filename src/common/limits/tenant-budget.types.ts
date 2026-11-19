export type OperationClass = string;

export interface TenantWeightConfig {
  readonly [operationClass: OperationClass]: number;
}

export interface TenantBudgetConfig {
  readonly normalLimit: number;
  readonly reservedLimit: number;
  readonly leaseTtlMs: number;
  readonly maxQueueDepth: number;
  readonly maxQueueWaitMs: number;
}

export interface AcquireRequest {
  readonly tenantId: string;
  readonly operationClass: OperationClass;
  readonly weight: number;
  readonly isSecurityOperation: boolean;
}

export interface BudgetLease {
  readonly leaseId: string;
  readonly tenantId: string;
  readonly weight: number;
  readonly acquiredAtMs: number;
  readonly expiresAtMs: number;
  release(): Promise<void>;
}

export interface AcquireResult {
  readonly lease: BudgetLease | null;
  readonly admitted: boolean;
  readonly rejectionReason?: string;
  readonly retryAfterSeconds?: number;
  readonly queueWaitMs?: number;
}

export interface TenantBudgetSnapshot {
  readonly tenantId: string;
  readonly normalInFlightWeight: number;
  readonly reservedInFlightWeight: number;
  readonly queueDepth: number;
  readonly oldestQueuedAtMs?: number;
}

export interface BudgetObservation {
  readonly tenantId: string;
  readonly operationClass: OperationClass;
  readonly weight: number;
  readonly isSecurityOperation: boolean;
  readonly outcome: "admitted" | "queued" | "rejected";
  readonly rejectionReason?: string;
  readonly queuedDurationMs?: number;
  readonly timestampMs: number;
}

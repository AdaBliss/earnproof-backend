import { SimulationMetrics, SimulationRejectionCode } from "./simulation-policy";

/**
 * Injection tokens for the anchoring service's two persistence-backed
 * collaborators. They are abstract classes (so Nest can inject them by type)
 * with no database imports, which keeps `ContractAnchoringService` loadable
 * without the Prisma client - its unit tests mock `child_process`, which the
 * Prisma client's platform detection also needs.
 */

export interface SequenceLease {
  accountKey: string;
  /** Unique per acquisition, so two holders in one process are still distinct. */
  token: string;
  /** Bumped on each takeover of an expired lease. */
  fencingCounter: number;
  expiresAt: Date;
}

export abstract class SequenceCoordinatorPort {
  /** @returns the lease, or `null` when another holder owns the account. */
  abstract acquire(source: string): Promise<SequenceLease | null>;
  /** @returns `false` if the lease expired or was taken over. */
  abstract renew(lease: SequenceLease): Promise<boolean>;
  abstract release(lease: SequenceLease): Promise<void>;
}

export interface SimulationAuditEntry {
  correlationId: string;
  operation: string;
  /** Already hashed by the caller; the raw proof id never reaches this layer. */
  proofIdHash: string;
  outcome: "approved" | "rejected";
  reasonCode?: SimulationRejectionCode;
  metrics?: SimulationMetrics;
}

export abstract class SimulationAuditPort {
  abstract recordSimulation(entry: SimulationAuditEntry): Promise<void>;
  abstract recordSubmission(
    correlationId: string,
    transactionHash: string,
  ): Promise<void>;
}

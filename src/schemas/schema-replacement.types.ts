/**
 * Schema Replacement Notice and Acknowledgement Types (#395)
 * 
 * Types for managing project schema activation notices and replacements.
 * Enables tracking of schema deprecation workflows and organization acknowledgements.
 */

import {
  SchemaReplacementStatus,
  SchemaReplacementAcknowledgementStatus,
} from "@prisma/client";

/**
 * Input for initiating a schema replacement notice.
 * Requires both predecessor and successor schema IDs and operational deadlines.
 */
export interface InitiateSchemaReplacementInput {
  /** ID of the schema being deprecated */
  predecessorSchemaId: string;
  
  /** ID of the replacement schema */
  successorSchemaId: string;
  
  /** Deadline for organizations to acknowledge replacement (ISO 8601 or Date) */
  deprecationDeadline: Date | string;
  
  /** Optional: deadline for complete sunset of predecessor schema */
  sunsetDeadline?: Date | string;
  
  /** Actor ID initiating the replacement */
  initiatedBy: string;
  
  /** Optional: reason for replacement (free-form) */
  reason?: string;
  
  /** Optional: additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Input for acknowledging a schema replacement notice.
 */
export interface AcknowledgeSchemaReplacementInput {
  /** Organization acknowledging the replacement */
  organizationId: string;
  
  /** Actor ID performing the acknowledgement */
  acknowledgedBy: string;
  
  /** Optional: action taken in response (e.g., "MIGRATED_PROOFS", "DEPRECATED_LOCALLY") */
  actionTaken?: string;
  
  /** Optional: timestamp when action was taken */
  actionAt?: Date;
  
  /** Optional: note for audit trail */
  note?: string;
}

/**
 * Response DTO for a schema replacement notice.
 */
export interface SchemaReplacementNoticeDto {
  id: string;
  
  // Predecessor and successor identification
  predecessorSchemaId: string;
  predecessorSchemaName: string; // schemaId from ProtocolSchema
  
  successorSchemaId: string;
  successorSchemaName: string; // schemaId from ProtocolSchema
  
  // Lifecycle and status
  status: SchemaReplacementStatus;
  
  // Deadlines and governance
  initiatedBy: string;
  initiatedAt: Date;
  deprecationDeadline: Date;
  sunsetDeadline: Date | null;
  
  // Metadata
  reason: string | null;
  metadata: unknown;
  
  // Tracking
  createdAt: Date;
  updatedAt: Date;
  
  // Acknowledgement summary
  totalOrganizations: number;
  acknowledgedCount: number;
  pendingCount: number;
  actedCount: number;
}

/**
 * Response DTO for a schema replacement acknowledgement.
 */
export interface SchemaReplacementAcknowledgementDto {
  id: string;
  
  // Notice reference
  noticeId: string;
  
  // Organization acknowledgement
  organizationId: string;
  organizationName: string;
  
  // Acknowledgement details
  acknowledgedBy: string;
  acknowledgedAt: Date;
  status: SchemaReplacementAcknowledgementStatus;
  
  // Action tracking
  actionTaken: string | null;
  actionAt: Date | null;
  note: string | null;
  
  // Tracking
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Readiness assessment finding for schema replacement.
 * Similar to contract successor findings, enables blocking/advisory status.
 */
export interface SchemaReplacementFinding {
  /** Unique key for this finding (e.g., "schema_not_found", "cycle_detected") */
  key: string;
  
  /** Severity: blocking prevents replacement, advisory/informational are warnings */
  severity: "blocking" | "advisory" | "informational";
  
  /** Human-readable description of the finding */
  description: string;
  
  /** Whether this finding has been acknowledged */
  acknowledged: boolean;
}

/**
 * Readiness assessment result for a schema replacement.
 */
export interface SchemaReplacementReadinessDto {
  /** The notice being assessed */
  noticeId: string;
  
  /** Overall readiness status */
  status: "ready" | "not_ready";
  
  /** Reason if not ready (deterministic status code) */
  reason?: string;
  
  /** List of findings blocking or warning about readiness */
  findings: SchemaReplacementFinding[];
  
  /** Overall severity of unacknowledged findings */
  overallSeverity: "blocking" | "advisory" | "informational" | "none";
  
  /** Organizational acknowledgement statistics */
  stats: {
    totalOrganizations: number;
    acknowledgedCount: number;
    actedCount: number;
    deferredCount: number;
  };
  
  /** Whether this result is cached (always fresh for new notices) */
  cached?: boolean;
  
  /** Age of cached result in milliseconds */
  ageMs?: number;
  
  /** When the assessment was performed */
  assessedAt: Date;
}

/**
 * Status codes for readiness assessment failures.
 */
export enum SchemaReplacementReadinessStatusCode {
  // Schema validation failures
  PREDECESSOR_NOT_FOUND = "PREDECESSOR_NOT_FOUND",
  SUCCESSOR_NOT_FOUND = "SUCCESSOR_NOT_FOUND",
  INVALID_LINEAGE = "INVALID_LINEAGE",
  CYCLE_DETECTED = "CYCLE_DETECTED",
  
  // Deadline validation failures
  DEPRECATION_DEADLINE_PASSED = "DEPRECATION_DEADLINE_PASSED",
  SUNSET_DEADLINE_INVALID = "SUNSET_DEADLINE_INVALID",
  
  // Acknowledgement failures
  BLOCKING_FINDINGS_UNACKNOWLEDGED = "BLOCKING_FINDINGS_UNACKNOWLEDGED",
  PENDING_ORGANIZATIONS = "PENDING_ORGANIZATIONS",
  
  // Assessment staleness
  ASSESSMENT_STALE = "ASSESSMENT_STALE",
  
  // Cross-network failures (if applicable)
  CROSS_NETWORK_LINEAGE = "CROSS_NETWORK_LINEAGE",
}

/**
 * Query options for listing schema replacement notices.
 */
export interface ListSchemaReplacementNoticesOptions {
  /** Filter by predecessor schema ID */
  predecessorSchemaId?: string;
  
  /** Filter by successor schema ID */
  successorSchemaId?: string;
  
  /** Filter by status */
  status?: SchemaReplacementStatus;
  
  /** Filter by network */
  network?: string;
  
  /** Filter: notices with deadline in the next N days */
  upcomingDeadlineDays?: number;
  
  /** Pagination: skip this many results */
  skip?: number;
  
  /** Pagination: return at most this many results */
  take?: number;
}

/**
 * Query options for listing acknowledgements of a notice.
 */
export interface ListSchemaReplacementAcknowledgementsOptions {
  /** Notice ID to filter by */
  noticeId: string;
  
  /** Filter by acknowledgement status */
  status?: SchemaReplacementAcknowledgementStatus;
  
  /** Filter by organization ID */
  organizationId?: string;
  
  /** Pagination: skip this many results */
  skip?: number;
  
  /** Pagination: return at most this many results */
  take?: number;
}

/**
 * Allowlisted webhook event types.
 *
 * Only these values may appear in Webhook.events or be used to
 * filter subscriptions. Arbitrary/unvalidated event names are rejected
 * at the DTO layer.
 */
export const WEBHOOK_EVENT_TYPES = [
  "proof.created",
  "proof.revoked",
  "proof.verified",
  "attestation.expired",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Per-event payload shapes — only public / non-sensitive fields are included.
// Private proof inputs (source transactions, exact aggregate income,
// threshold values, encrypted fields) must NEVER appear here.
// ---------------------------------------------------------------------------

export interface ProofCreatedPayload {
  proofId: string;
  proofType: string;
  schemaVersion: string;
  status: string;
  network: string;
  assetCode: string;
  /** null when asset is the native asset */
  assetIssuer: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  expiresAt: string;
  credentialHash: string;
  /** present only when contract anchoring is enabled */
  contractTransactionHash: string | null;
  issuedAt: string;
}

export interface ProofRevokedPayload {
  proofId: string;
  status: string;
  revokedAt: string;
}

export interface ProofVerifiedPayload {
  proofId: string;
  result: string;
  verifiedAt: string;
}

export interface AttestationExpiredPayload {
  attestationId: string;
  issuerId: string;
  /** Hashed subject identifier — never a raw wallet address. */
  subjectWalletHash: string;
  /** Stored status before reconciliation moved it. */
  previousStatus: string;
  /** Effective status after reconciliation — "EXPIRED". */
  effectiveStatus: string;
  expiresAt: string;
  reconciledAt: string;
}

export type WebhookEventPayload =
  | { event: "proof.created"; data: ProofCreatedPayload }
  | { event: "proof.revoked"; data: ProofRevokedPayload }
  | { event: "proof.verified"; data: ProofVerifiedPayload }
  | { event: "attestation.expired"; data: AttestationExpiredPayload };

/**
 * The versioned envelope sent to every webhook endpoint.
 *
 * Integrators should verify `specVersion` before parsing `data`.
 */
export interface WebhookEnvelope {
  specVersion: "1";
  id: string; // delivery eventId — idempotency key for the integrator
  event: WebhookEventType;
  createdAt: string; // ISO-8601
  data:
    | ProofCreatedPayload
    | ProofRevokedPayload
    | ProofVerifiedPayload
    | AttestationExpiredPayload;
}

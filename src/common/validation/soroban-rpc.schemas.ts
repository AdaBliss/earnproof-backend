import { z } from "zod";

/**
 * Runtime schemas for Soroban RPC responses.
 *
 * Contract submission and reconciliation consume responses from an external
 * service whose shape can drift or arrive malformed. Everything the business
 * logic reads must pass through `parseSorobanRpcResponse` first, so that a bad
 * response fails closed with a stable domain error rather than surfacing as an
 * `undefined` dereference deep in a reconciler.
 *
 * Forward compatibility: the object schemas are non-strict, so additive fields
 * the RPC adds later are accepted and dropped from the parsed result.
 *
 * Privacy: `SorobanRpcResponseError` carries only the response kind, a stable
 * code, and schema paths. It never carries a received value, so neither the
 * error message nor anything logged from it can contain a raw RPC payload.
 */

/** Hard bounds. A response beyond these is treated as hostile or broken. */
export const SOROBAN_RPC_LIMITS = {
  /** Serialised size of one whole response. */
  maxResponseBytes: 2 * 1024 * 1024,
  /** Length of any single XDR / opaque string field. */
  maxFieldLength: 256 * 1024,
  /** Events returned by one getEvents call. */
  maxEvents: 10_000,
  /** Topics on one event. */
  maxTopics: 8,
  /** Results on one simulation. */
  maxSimulationResults: 64,
} as const;

export type SorobanRpcResponseKind =
  | "transaction"
  | "simulation"
  | "events"
  | "digest"
  | "error";

export type SorobanRpcErrorCode =
  | "SOROBAN_RPC_RESPONSE_MALFORMED"
  | "SOROBAN_RPC_RESPONSE_TOO_LARGE"
  | "SOROBAN_RPC_REPORTED_ERROR";

/** Stable domain error for any RPC response that cannot be trusted. */
export class SorobanRpcResponseError extends Error {
  constructor(
    readonly code: SorobanRpcErrorCode,
    readonly kind: SorobanRpcResponseKind,
    /** Schema paths that failed. Never contains received values. */
    readonly paths: readonly string[] = [],
  ) {
    super(
      `${code}: ${kind} response rejected` +
        (paths.length > 0 ? ` (${paths.join(", ")})` : ""),
    );
    this.name = "SorobanRpcResponseError";
  }
}

const bounded = () => z.string().max(SOROBAN_RPC_LIMITS.maxFieldLength);
const ledgerNumber = z.number().int().nonnegative().safe();
/** Soroban RPC encodes some large integers as decimal strings. */
const decimalString = z.string().regex(/^\d{1,40}$/);

export const sorobanTransactionResponseSchema = z.object({
  status: z.enum(["SUCCESS", "FAILED", "NOT_FOUND"]),
  latestLedger: ledgerNumber,
  oldestLedger: ledgerNumber.optional(),
  ledger: ledgerNumber.optional(),
  applicationOrder: z.number().int().nonnegative().optional(),
  txHash: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/)
    .optional(),
  envelopeXdr: bounded().optional(),
  resultXdr: bounded().optional(),
  resultMetaXdr: bounded().optional(),
});

export const sorobanSimulationResponseSchema = z.object({
  latestLedger: ledgerNumber,
  minResourceFee: decimalString.optional(),
  transactionData: bounded().optional(),
  results: z
    .array(
      z.object({
        auth: z.array(bounded()).max(64).optional(),
        xdr: bounded().optional(),
      }),
    )
    .max(SOROBAN_RPC_LIMITS.maxSimulationResults)
    .optional(),
  events: z.array(bounded()).max(SOROBAN_RPC_LIMITS.maxEvents).optional(),
  // A simulation that failed reports `error` instead of `results`.
  error: bounded().optional(),
});

export const sorobanEventSchema = z.object({
  type: z.enum(["contract", "system", "diagnostic"]),
  ledger: ledgerNumber,
  id: z.string().min(1).max(128),
  contractId: z.string().min(1).max(128).optional(),
  topic: z.array(bounded()).max(SOROBAN_RPC_LIMITS.maxTopics),
  value: bounded(),
  inSuccessfulContractCall: z.boolean(),
  txHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
});

export const sorobanEventsResponseSchema = z.object({
  latestLedger: ledgerNumber,
  events: z.array(sorobanEventSchema).max(SOROBAN_RPC_LIMITS.maxEvents),
  cursor: z.string().max(256).optional(),
});

/** Checkpoint digest returned by the registry contract's read method. */
export const sorobanDigestResponseSchema = z.object({
  network: z.string().min(1).max(64),
  contractId: z.string().min(1).max(128),
  checkpointNumber: z.string().regex(/^\d{1,40}$/),
  digestVersion: z.string().min(1).max(32),
  components: z.record(z.string().max(128), z.string().max(1024)).refine(
    (components) => Object.keys(components).length <= 64,
    "too many components",
  ),
  timestamp: z.string().max(64).refine((value) => !Number.isNaN(Date.parse(value)), "invalid date"),
});

/** JSON-RPC error object as returned in place of `result`. */
export const sorobanRpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string().max(4096),
});

export type SorobanTransactionResponse = z.infer<
  typeof sorobanTransactionResponseSchema
>;
export type SorobanSimulationResponse = z.infer<
  typeof sorobanSimulationResponseSchema
>;
export type SorobanEvent = z.infer<typeof sorobanEventSchema>;
export type SorobanEventsResponse = z.infer<typeof sorobanEventsResponseSchema>;
export type SorobanDigestResponse = z.infer<typeof sorobanDigestResponseSchema>;
export type SorobanRpcError = z.infer<typeof sorobanRpcErrorSchema>;

interface ResponseKindMap {
  transaction: SorobanTransactionResponse;
  simulation: SorobanSimulationResponse;
  events: SorobanEventsResponse;
  digest: SorobanDigestResponse;
  error: SorobanRpcError;
}

const SCHEMAS = {
  transaction: sorobanTransactionResponseSchema,
  simulation: sorobanSimulationResponseSchema,
  events: sorobanEventsResponseSchema,
  digest: sorobanDigestResponseSchema,
  error: sorobanRpcErrorSchema,
} as const;

/** Serialised size without allocating for pathological input. */
function exceedsResponseBudget(value: unknown): boolean {
  try {
    const serialised = JSON.stringify(value);
    return (
      serialised !== undefined &&
      serialised.length > SOROBAN_RPC_LIMITS.maxResponseBytes
    );
  } catch {
    // Circular or otherwise unserialisable: not a response we can trust.
    return true;
  }
}

/**
 * Validates an RPC response before business logic reads it.
 *
 * @throws SorobanRpcResponseError `SOROBAN_RPC_RESPONSE_TOO_LARGE` when the
 *   payload exceeds the size budget, or `SOROBAN_RPC_RESPONSE_MALFORMED` when it
 *   does not match the schema for `kind`.
 */
export function parseSorobanRpcResponse<K extends SorobanRpcResponseKind>(
  kind: K,
  payload: unknown,
): ResponseKindMap[K] {
  if (exceedsResponseBudget(payload)) {
    throw new SorobanRpcResponseError("SOROBAN_RPC_RESPONSE_TOO_LARGE", kind);
  }

  const result = SCHEMAS[kind].safeParse(payload);
  if (!result.success) {
    const paths = [
      ...new Set(
        result.error.issues.map((issue) =>
          issue.path.length > 0 ? issue.path.join(".") : "(root)",
        ),
      ),
    ].slice(0, 10);
    throw new SorobanRpcResponseError(
      "SOROBAN_RPC_RESPONSE_MALFORMED",
      kind,
      paths,
    );
  }
  return result.data as ResponseKindMap[K];
}

/**
 * Validates a JSON-RPC envelope and returns its `result`.
 *
 * An envelope carrying an `error` is surfaced as `SOROBAN_RPC_REPORTED_ERROR`
 * (after the error object itself is validated) so callers can tell "the RPC
 * said no" from "the RPC sent garbage". An envelope with neither is malformed.
 */
export function unwrapSorobanRpcEnvelope(
  kind: Exclude<SorobanRpcResponseKind, "error">,
  envelope: unknown,
): ResponseKindMap[typeof kind] {
  if (exceedsResponseBudget(envelope)) {
    throw new SorobanRpcResponseError("SOROBAN_RPC_RESPONSE_TOO_LARGE", kind);
  }
  if (typeof envelope !== "object" || envelope === null) {
    throw new SorobanRpcResponseError("SOROBAN_RPC_RESPONSE_MALFORMED", kind, [
      "(root)",
    ]);
  }

  const body = envelope as { result?: unknown; error?: unknown };
  if (body.error !== undefined) {
    parseSorobanRpcResponse("error", body.error);
    throw new SorobanRpcResponseError("SOROBAN_RPC_REPORTED_ERROR", kind);
  }
  if (body.result === undefined) {
    throw new SorobanRpcResponseError("SOROBAN_RPC_RESPONSE_MALFORMED", kind, [
      "result",
    ]);
  }
  return parseSorobanRpcResponse(kind, body.result);
}

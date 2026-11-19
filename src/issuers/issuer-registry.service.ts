import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { IssuerAssuranceLevel, ResourceStatus } from "@prisma/client";
import { execFile } from "child_process";
import { promisify } from "util";
import { sha256 } from "../common/crypto/hash";
import { redact } from "../common/observability/redaction";

const execFileAsync = promisify(execFile);

export type IssuerRegistrySyncInput = {
  issuerId: string;
  stellarAddress: string;
  metadataHash: string;
  status: ResourceStatus;
  contractSyncedStatus: ResourceStatus | null;
};

export type IssuerRegistrySyncResult =
  | { state: "synced"; transactionHash: string; operation: string }
  | { state: "pending"; reason: string }
  | { state: "disabled"; reason: string }
  | { state: "failed"; reason: string; error: string };

/** The issuer address the contract currently holds for an issuer. */
export type IssuerRegistryAddressRead =
  | { state: "found"; issuerAddress: string }
  | { state: "disabled"; reason: string }
  | { state: "failed"; error: string };

/**
 * The contract-backed assurance and accreditation state the registry holds
 * for an issuer, with its provenance.
 *
 * This is the only source the backend trusts for assurance facts: tenant
 * metadata can never produce a `found` result. `observedAt` records when the
 * contract was read, so readers can tell a fresh observation from a stale
 * projection; `contractId` and `network` say exactly which contract was read.
 */
export type IssuerRegistryAssuranceRead =
  | {
      state: "found";
      issuerAddress: string;
      assuranceLevel: IssuerAssuranceLevel;
      /** Null when the contract records an accreditation with no expiry. */
      accreditationExpiresAt: Date | null;
      contractId: string;
      network: string;
      observedAt: Date;
    }
  | { state: "disabled"; reason: string }
  | { state: "failed"; error: string };

export type IssuerRegistryRotationResult =
  | { state: "submitted"; transactionHash: string }
  | { state: "disabled"; reason: string }
  | { state: "failed"; error: string };

/** A Stellar account (G...) or contract (C...) address in StrKey form. */
const STRKEY_ADDRESS = /\b([GC][A-Z2-7]{55})\b/;

@Injectable()
export class IssuerRegistryService {
  private readonly logger = new Logger(IssuerRegistryService.name);
  private readonly enabled: boolean;
  private readonly stellarCliPath: string;
  private readonly source?: string;
  private readonly network: string;
  private readonly contractId?: string;

  /** True when the registry is enabled and every setting it needs is present. */
  get isConfigured(): boolean {
    return Boolean(this.enabled && this.source && this.contractId);
  }

  /**
   * Reads the address the contract holds for `issuerId`.
   *
   * A read-only simulation: no source account signs it and nothing is
   * submitted, so it is safe to repeat as often as reconciliation needs.
   */
  async readIssuerAddress(issuerId: string): Promise<IssuerRegistryAddressRead> {
    if (!this.isConfigured) {
      return { state: "disabled", reason: "Issuer registry synchronization is not configured" };
    }

    try {
      const stdout = await this.execute(
        [
          "contract",
          "invoke",
          "--network",
          this.network,
          "--id",
          this.contractId!,
          "--",
          "get_issuer",
          "--issuer_id_hash",
          sha256(issuerId),
        ],
        60_000,
      );
      const issuerAddress = parseIssuerAddress(stdout);
      if (!issuerAddress) {
        return { state: "failed", error: "Issuer registry returned no issuer address" };
      }
      return { state: "found", issuerAddress };
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : "Unknown error");
      this.logger.warn(`Issuer registry read failed: ${message}`);
      return { state: "failed", error: message };
    }
  }

  /**
   * Reads the assurance and accreditation state the contract holds for
   * `issuerId`.
   *
   * A read-only simulation over the same `get_issuer` record
   * {@link readIssuerAddress} uses: no source account signs it and nothing
   * is submitted, so it is safe to repeat as often as reconciliation needs.
   * The contract is the only source of these facts — a read that fails or is
   * disabled yields no assurance, and callers must fail closed on it rather
   * than falling back to tenant metadata or a stale projection.
   */
  async readIssuerAssurance(
    issuerId: string,
  ): Promise<IssuerRegistryAssuranceRead> {
    if (!this.isConfigured) {
      return { state: "disabled", reason: "Issuer registry synchronization is not configured" };
    }

    try {
      const stdout = await this.execute(
        [
          "contract",
          "invoke",
          "--network",
          this.network,
          "--id",
          this.contractId!,
          "--",
          "get_issuer",
          "--issuer_id_hash",
          sha256(issuerId),
        ],
        60_000,
      );
      const parsed = parseIssuerAssurance(stdout);
      if (!parsed) {
        return { state: "failed", error: "Issuer registry returned no issuer assurance" };
      }
      return {
        state: "found",
        issuerAddress: parsed.issuerAddress,
        assuranceLevel: parsed.assuranceLevel,
        accreditationExpiresAt: parsed.accreditationExpiresAt,
        contractId: this.contractId!,
        network: this.network,
        observedAt: new Date(),
      };
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : "Unknown error");
      this.logger.warn(`Issuer registry assurance read failed: ${message}`);
      return { state: "failed", error: message };
    }
  }

  /**
   * Submits `rotate_issuer_address`. The contract itself rejects a revoked
   * issuer, an unchanged address and an address already registered to any
   * issuer.
   */
  async rotateIssuerAddress(
    issuerId: string,
    newAddress: string,
  ): Promise<IssuerRegistryRotationResult> {
    if (!this.isConfigured) {
      return { state: "disabled", reason: "Issuer registry synchronization is not configured" };
    }

    try {
      const stdout = await this.execute(
        [
          "contract",
          "invoke",
          "--source",
          this.source!,
          "--network",
          this.network,
          "--id",
          this.contractId!,
          "--",
          "rotate_issuer_address",
          "--issuer_id_hash",
          sha256(issuerId),
          "--new_address",
          newAddress,
        ],
        120_000,
      );
      const transactionHash = lastLine(stdout);
      if (!transactionHash) {
        return { state: "failed", error: "Issuer registry returned no transaction evidence" };
      }
      return { state: "submitted", transactionHash };
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : "Unknown error");
      this.logger.warn(`Issuer address rotation submission failed: ${message}`);
      return { state: "failed", error: message };
    }
  }

  /** Runs the Stellar CLI. Separate so tests can substitute the process. */
  protected async execute(args: string[], timeout: number): Promise<string> {
    const { stdout } = await execFileAsync(this.stellarCliPath, args, {
      windowsHide: true,
      timeout,
    });
    return stdout;
  }

  constructor(config: ConfigService) {
    this.enabled = config.get<boolean>("issuerRegistry.enabled") ?? false;
    this.stellarCliPath =
      config.get<string>("issuerRegistry.stellarCliPath") ?? "stellar";
    this.source = config.get<string>("issuerRegistry.source");
    this.network = config.get<string>("stellar.network") ?? "testnet";
    this.contractId = config.get<string>("issuerRegistry.contractId");
  }

  async sync(
    input: IssuerRegistrySyncInput,
  ): Promise<IssuerRegistrySyncResult> {
    if (input.status === ResourceStatus.PENDING) {
      return {
        state: "pending",
        reason: "Issuer must be ACTIVE before contract registration",
      };
    }

    if (!this.enabled || !this.source || !this.contractId) {
      return {
        state: "disabled",
        reason: "Issuer registry synchronization is not configured",
      };
    }

    const issuerIdHash = sha256(input.issuerId);
    let operation: string;
    let args: string[];

    if (!input.contractSyncedStatus) {
      if (input.status !== ResourceStatus.ACTIVE) {
        return {
          state: "pending",
          reason:
            "Issuer must be registered while ACTIVE before status synchronization",
        };
      }
      operation = "register_issuer";
      args = [
        "--issuer_id_hash",
        issuerIdHash,
        "--issuer_address",
        input.stellarAddress,
        "--metadata_hash",
        input.metadataHash,
      ];
    } else if (
      input.status === ResourceStatus.ACTIVE &&
      input.contractSyncedStatus === ResourceStatus.SUSPENDED
    ) {
      operation = "reactivate_issuer";
      args = ["--issuer_id_hash", issuerIdHash];
    } else if (input.status === ResourceStatus.ACTIVE) {
      operation = "update_issuer";
      args = [
        "--issuer_id_hash",
        issuerIdHash,
        "--metadata_hash",
        input.metadataHash,
      ];
    } else if (input.status === ResourceStatus.SUSPENDED) {
      operation = "suspend_issuer";
      args = ["--issuer_id_hash", issuerIdHash];
    } else if (input.status === ResourceStatus.REVOKED) {
      operation = "revoke_issuer";
      args = ["--issuer_id_hash", issuerIdHash];
    } else {
      return {
        state: "pending",
        reason: `Status ${input.status} is not syncable`,
      };
    }

    try {
      const { stdout } = await execFileAsync(
        this.stellarCliPath,
        [
          "contract",
          "invoke",
          "--source",
          this.source,
          "--network",
          this.network,
          "--id",
          this.contractId,
          "--",
          operation,
          ...args,
        ],
        { windowsHide: true, timeout: 120_000 },
      );
      const transactionHash = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);

      if (!transactionHash) {
        throw new Error("Issuer registry returned no transaction evidence");
      }
      return { state: "synced", transactionHash, operation };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.logger.warn(`Issuer registry sync failed: ${message}`);
      return { state: "failed", reason: "failed", error: message };
    }
  }
}

function lastLine(stdout: string): string | undefined {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

/**
 * Extracts `issuer_address` from `get_issuer` output. The CLI prints the
 * record as JSON; the pattern fallback tolerates a CLI version that wraps it.
 */
export function parseIssuerAddress(stdout: string): string | undefined {
  const line = lastLine(stdout);
  if (!line) return undefined;
  try {
    const record = JSON.parse(line) as { issuer_address?: unknown };
    if (typeof record.issuer_address === "string" && STRKEY_ADDRESS.test(record.issuer_address)) {
      return record.issuer_address;
    }
  } catch {
    // Not JSON; fall through to the pattern.
  }
  const match = /"?issuer_address"?\s*:\s*"?([GC][A-Z2-7]{55})/.exec(stdout);
  return match?.[1];
}

export type ParsedIssuerAssurance = {
  issuerAddress: string;
  assuranceLevel: IssuerAssuranceLevel;
  /** Null when the contract records an accreditation with no expiry. */
  accreditationExpiresAt: Date | null;
};

const ASSURANCE_LEVELS = new Set<string>(Object.values(IssuerAssuranceLevel));

/**
 * Extracts the assurance record from `get_issuer` output.
 *
 * Returns `undefined` unless the record carries a registered issuer address
 * and a recognized assurance level: an unrecognized level or an unparseable
 * expiry is a failed read, never a guess — callers fail closed on it. A
 * missing `accreditation_expires_at` means the contract records an
 * accreditation with no expiry (perpetual), not an absent accreditation;
 * `assurance_level: "NONE"` is what records the absence.
 */
export function parseIssuerAssurance(
  stdout: string,
): ParsedIssuerAssurance | undefined {
  const issuerAddress = parseIssuerAddress(stdout);
  if (!issuerAddress) return undefined;

  const line = lastLine(stdout);
  let level: unknown;
  let expiresAt: unknown;
  let parsedJson = false;
  if (line) {
    try {
      const record = JSON.parse(line) as {
        assurance_level?: unknown;
        accreditation_expires_at?: unknown;
      };
      level = record.assurance_level;
      expiresAt = record.accreditation_expires_at;
      parsedJson = true;
    } catch {
      // Not JSON; fall through to the pattern.
    }
  }
  if (!parsedJson) {
    level = /"?assurance_level"?\s*:\s*"?([A-Za-z]+)"?/.exec(stdout)?.[1];
    const rawExpiry =
      /"?accreditation_expires_at"?\s*:\s*"?([^",}\s]+)"?/.exec(stdout)?.[1];
    expiresAt = rawExpiry === undefined ? undefined : rawExpiry;
  }

  if (typeof level !== "string") return undefined;
  const normalizedLevel = level.toUpperCase();
  if (!ASSURANCE_LEVELS.has(normalizedLevel)) return undefined;

  const accreditationExpiresAt = parseAccreditationExpiry(expiresAt);
  if (accreditationExpiresAt === undefined) return undefined;

  return {
    issuerAddress,
    assuranceLevel: normalizedLevel as IssuerAssuranceLevel,
    accreditationExpiresAt,
  };
}

/**
 * Parses a contract `accreditation_expires_at` value.
 *
 * Accepts an ISO-8601 string or a Unix epoch (seconds; a millisecond value
 * is detected by magnitude). Returns `null` for a missing value (perpetual)
 * and `undefined` for a present-but-unparseable one, which the caller treats
 * as a failed read.
 */
function parseAccreditationExpiry(
  value: unknown,
): Date | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e11 ? value : value * 1_000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const asNumber = Number(trimmed);
    if (trimmed !== "" && Number.isFinite(asNumber)) {
      return parseAccreditationExpiry(asNumber);
    }
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? undefined : new Date(ms);
  }
  return undefined;
}

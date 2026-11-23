import { Address, Keypair, StrKey, xdr } from "@stellar/stellar-base";

/**
 * Builders for Soroban RPC payloads used by the simulation, sequence-lease and
 * identity-gate tests. Everything is synthetic: random keys, fixed contract
 * ids, no real network or account data.
 */

export const TEST_CONTRACT_ID =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
export const OTHER_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));

/** A base64 `SorobanAuthorizationEntry` expiring at `expirationLedger`. */
export function authEntry(
  expirationLedger: number,
  credentials: "address" | "source" = "address",
): string {
  const credential =
    credentials === "address"
      ? xdr.SorobanCredentials.sorobanCredentialsAddress(
          new xdr.SorobanAddressCredentials({
            address: new Address(Keypair.random().publicKey()).toScAddress(),
            nonce: xdr.Int64.fromString("1"),
            signatureExpirationLedger: expirationLedger,
            signature: xdr.ScVal.scvVoid(),
          }),
        )
      : xdr.SorobanCredentials.sorobanCredentialsSourceAccount();

  return new xdr.SorobanAuthorizationEntry({
    credentials: credential,
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(TEST_CONTRACT_ID).toScAddress(),
          functionName: "register_proof",
          args: [],
        }),
      ),
      subInvocations: [],
    }),
  }).toXDR("base64");
}

export interface SimulationOverrides {
  latestLedger?: number | string;
  minResourceFee?: string;
  cpuInsns?: string;
  memBytes?: string;
  auth?: string[];
  restore?: boolean;
  error?: string;
  /** Replace the whole payload (for malformed-output cases). */
  raw?: unknown;
}

/** A well-formed `simulateTransaction` result; override fields to break it. */
export function simulationResult(overrides: SimulationOverrides = {}): unknown {
  if ("raw" in overrides) return overrides.raw;
  if (overrides.error !== undefined) {
    return { latestLedger: 1000, error: overrides.error };
  }
  return {
    latestLedger: overrides.latestLedger ?? 1000,
    minResourceFee: overrides.minResourceFee ?? "100000",
    transactionData: "AAAA",
    cost: {
      cpuInsns: overrides.cpuInsns ?? "5000000",
      memBytes: overrides.memBytes ?? "1000000",
    },
    results: [{ auth: overrides.auth ?? [], xdr: "AAAAAQ==" }],
    ...(overrides.restore
      ? { restorePreamble: { minResourceFee: "10", transactionData: "AAAA" } }
      : {}),
  };
}

/** A `getLedgerEntries` result holding a contract instance with a WASM hash. */
export function contractInstanceEntries(
  contractId: string,
  wasmHashHex: string,
): unknown {
  const entry = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable: xdr.ContractExecutable.contractExecutableWasm(
            Buffer.from(wasmHashHex, "hex"),
          ),
          storage: null,
        }),
      ),
    }),
  );
  return {
    latestLedger: 1000,
    entries: [{ key: "AAAA", xdr: entry.toXDR("base64"), lastModifiedLedgerSeq: 1 }],
  };
}

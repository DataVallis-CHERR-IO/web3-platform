import {
  BaseError, ContractFunctionRevertedError, UserRejectedRequestError, createPublicClient, createWalletClient, custom, getAddress,
  type Address, type EIP1193Provider, type Hash, type PublicClient,
} from "viem";
import { PlatformConfigAbi } from "@cherrio/contracts/abis";
import { polygonFeesFrom } from "@/lib/campaigns/publish-client";
import { CONFIG_PARAMS, encodeSetter, type ConfigKey, type RawValue } from "./config-params";
import {
  OPERATION_STATES, TimelockAbi, ZERO_BYTES32, randomSalt, zeroValues, type BatchOperation, type OperationState,
} from "./timelock";

// Browser side of the contract admin console (TASK-034b, ADR-046). Reads go
// through a public client (the same-origin `/api/rpc` proxy or the wallet's own
// provider); writes are signed by the admin's connected wallet. Nothing here
// talks to the server. Pure logic, no React: unit-tested with a fake provider.
//
// The write helpers take an optional `read` client. The console passes the
// `/api/rpc` client so role checks, fees and receipts do not depend on the
// wallet's own RPC (MetaMask's Amoy RPC failed calls on dev, 2026-10-04): the
// wallet then answers only eth_chainId and eth_sendTransaction.

export interface ConsoleChain {
  chainId: number;
  timelock: Address;
  platformConfig: Address;
}

export interface ConsoleSnapshot {
  values: Record<ConfigKey, RawValue>;
  minDelay: bigint;
}

export interface WalletRoles {
  proposer: boolean;
  executor: boolean;
  canceller: boolean;
  operator: boolean;
  guardian: boolean;
}

export type ConsoleFailure =
  | "wrong_network"
  | "not_proposer"
  | "not_executor"
  | "not_canceller"
  | "not_ready"
  | "rejected"
  | "insufficient_gas"
  | "reverted"
  | "failed";

export class ConsoleError extends Error {
  constructor(public readonly code: ConsoleFailure) {
    super(code);
    this.name = "ConsoleError";
  }
}

export type Reader = Pick<PublicClient, "readContract">;

/** What the write helpers read: contract state, fees and receipts. */
export type ChainReader = Pick<PublicClient, "readContract" | "getBlock" | "estimateMaxPriorityFeePerGas" | "waitForTransactionReceipt">;

/** Current PlatformConfig values and the timelock delay. */
export async function readSnapshot(read: Reader, chain: ConsoleChain): Promise<ConsoleSnapshot> {
  const values = await Promise.all(
    CONFIG_PARAMS.map((p) =>
      read.readContract({ address: chain.platformConfig, abi: PlatformConfigAbi, functionName: p.key }) as Promise<unknown>
    )
  );
  const minDelay = (await read.readContract({ address: chain.timelock, abi: TimelockAbi, functionName: "getMinDelay" })) as bigint;
  const out = {} as Record<ConfigKey, RawValue>;
  CONFIG_PARAMS.forEach((p, i) => {
    const v = values[i];
    out[p.key] = p.kind === "address" ? getAddress(v as string) : BigInt(v as number | bigint);
  });
  return { values: out, minDelay };
}

/** Which console actions this account may take. */
export async function readRoles(read: Reader, chain: ConsoleChain, account: Address): Promise<WalletRoles> {
  const role = (address: Address, abi: typeof TimelockAbi | typeof PlatformConfigAbi, name: string) =>
    read.readContract({ address, abi, functionName: name as never }) as Promise<`0x${string}`>;
  const has = (address: Address, abi: typeof TimelockAbi | typeof PlatformConfigAbi, r: `0x${string}`, who: Address) =>
    read.readContract({ address, abi, functionName: "hasRole" as never, args: [r, who] as never }) as Promise<boolean>;
  const [proposerRole, executorRole, cancellerRole, operatorRole, guardianRole] = await Promise.all([
    role(chain.timelock, TimelockAbi, "PROPOSER_ROLE"),
    role(chain.timelock, TimelockAbi, "EXECUTOR_ROLE"),
    role(chain.timelock, TimelockAbi, "CANCELLER_ROLE"),
    role(chain.platformConfig, PlatformConfigAbi, "OPERATOR_ROLE"),
    role(chain.platformConfig, PlatformConfigAbi, "GUARDIAN_ROLE"),
  ]);
  const zero: Address = "0x0000000000000000000000000000000000000000";
  const [proposer, executor, openExecutor, canceller, operator, guardian] = await Promise.all([
    has(chain.timelock, TimelockAbi, proposerRole, account),
    has(chain.timelock, TimelockAbi, executorRole, account),
    has(chain.timelock, TimelockAbi, executorRole, zero), // OZ "open role": anyone may execute
    has(chain.timelock, TimelockAbi, cancellerRole, account),
    has(chain.platformConfig, PlatformConfigAbi, operatorRole, account),
    has(chain.platformConfig, PlatformConfigAbi, guardianRole, account),
  ]);
  return { proposer, executor: executor || openExecutor, canceller, operator, guardian };
}

export interface OperationStatus {
  state: OperationState;
  /** Seconds since epoch when it becomes executable; 0 when unset, 1 when done. */
  readyAt: bigint;
}

export async function readOperation(read: Reader, timelock: Address, id: `0x${string}`): Promise<OperationStatus> {
  const [state, readyAt] = await Promise.all([
    read.readContract({ address: timelock, abi: TimelockAbi, functionName: "getOperationState", args: [id] }) as Promise<number>,
    read.readContract({ address: timelock, abi: TimelockAbi, functionName: "getTimestamp", args: [id] }) as Promise<bigint>,
  ]);
  return { state: OPERATION_STATES[Number(state)] ?? "unset", readyAt };
}

/** One batch for all changed values, in the order of CONFIG_PARAMS. */
export function buildOperation(chain: ConsoleChain, changes: Partial<Record<ConfigKey, RawValue>>, salt = randomSalt()): BatchOperation {
  const specs = CONFIG_PARAMS.filter((p) => changes[p.key] !== undefined);
  if (specs.length === 0) throw new Error("no changes");
  return {
    targets: specs.map(() => chain.platformConfig),
    payloads: specs.map((p) => encodeSetter(p, changes[p.key]!)),
    predecessor: ZERO_BYTES32,
    salt,
  };
}

/** Maps what a wallet or node throws to a ConsoleFailure. */
export function toConsoleFailure(error: unknown): ConsoleFailure {
  if (error instanceof ConsoleError) return error.code;
  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof UserRejectedRequestError)) return "rejected";
    if (error.walk((e) => e instanceof ContractFunctionRevertedError)) return "reverted";
  }
  const e = error as { code?: unknown; message?: unknown } | null;
  if (e && (e.code === 4001 || e.code === "ACTION_REJECTED")) return "rejected";
  const message = String(e?.message ?? "").toLowerCase();
  if (message.includes("user rejected") || message.includes("user denied")) return "rejected";
  if (message.includes("insufficient funds")) return "insufficient_gas";
  return "failed";
}

const clients = (provider: EIP1193Provider, account: Address, read?: ChainReader) => {
  const wallet = createPublicClient({ transport: custom(provider) });
  return { wallet, read: read ?? wallet, write: createWalletClient({ account, transport: custom(provider) }) };
};

/** The wallet's own network (answered by the wallet itself, no RPC). */
async function checkChain(wallet: Pick<PublicClient, "getChainId">, chainId: number) {
  if ((await wallet.getChainId()) !== chainId) throw new ConsoleError("wrong_network");
}

/** scheduleBatch(op, delay) from the proposer wallet. Checks chain and role first. */
export async function scheduleChange(
  provider: EIP1193Provider, account: Address, chain: ConsoleChain, op: BatchOperation, delay: bigint, reader?: ChainReader
): Promise<Hash> {
  const { wallet, read, write } = clients(provider, account, reader);
  await checkChain(wallet, chain.chainId);
  if (!(await readRoles(read, chain, account)).proposer) throw new ConsoleError("not_proposer");
  return write.writeContract({
    address: chain.timelock, abi: TimelockAbi, functionName: "scheduleBatch",
    args: [op.targets, zeroValues(op), op.payloads, op.predecessor, op.salt, delay],
    chain: null, ...(await polygonFeesFrom(read)),
  });
}

/** executeBatch(op) once the operation is ready. */
export async function executeChange(
  provider: EIP1193Provider, account: Address, chain: ConsoleChain, op: BatchOperation, id: `0x${string}`, reader?: ChainReader
): Promise<Hash> {
  const { wallet, read, write } = clients(provider, account, reader);
  await checkChain(wallet, chain.chainId);
  if (!(await readRoles(read, chain, account)).executor) throw new ConsoleError("not_executor");
  if ((await readOperation(read, chain.timelock, id)).state !== "ready") throw new ConsoleError("not_ready");
  return write.writeContract({
    address: chain.timelock, abi: TimelockAbi, functionName: "executeBatch",
    args: [op.targets, zeroValues(op), op.payloads, op.predecessor, op.salt],
    chain: null, ...(await polygonFeesFrom(read)),
  });
}

/** cancel(id) while the operation waits or is ready. */
export async function cancelChange(
  provider: EIP1193Provider, account: Address, chain: ConsoleChain, id: `0x${string}`, reader?: ChainReader
): Promise<Hash> {
  const { wallet, read, write } = clients(provider, account, reader);
  await checkChain(wallet, chain.chainId);
  if (!(await readRoles(read, chain, account)).canceller) throw new ConsoleError("not_canceller");
  return write.writeContract({
    address: chain.timelock, abi: TimelockAbi, functionName: "cancel", args: [id],
    chain: null, ...(await polygonFeesFrom(read)),
  });
}

export type TxOutcome = "success" | "reverted" | "unknown";

/**
 * Waits for a transaction. "unknown" = the receipt could not be read in time
 * (RPC error or timeout): the transaction was sent and may still be mined, so
 * the console says "sent, waiting for confirmation" instead of an error.
 */
export async function waitForConsoleTx(
  read: Pick<PublicClient, "waitForTransactionReceipt">, hash: Hash, timeoutMs = 180_000
): Promise<TxOutcome> {
  try {
    const receipt = await read.waitForTransactionReceipt({ hash, timeout: timeoutMs, pollingInterval: 3_000 });
    return receipt.status === "success" ? "success" : "reverted";
  } catch (e) {
    console.error("[contracts] receipt", hash, e);
    return "unknown";
  }
}

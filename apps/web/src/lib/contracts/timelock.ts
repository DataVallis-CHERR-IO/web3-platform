import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, type Address, type Hex } from "viem";

// TimelockController helpers for the admin console (TASK-034, ADR-046).
// The ABI subset matches OpenZeppelin v5 `governance/TimelockController.sol`
// (packages/contracts/lib/openzeppelin-contracts), which DeployAmoy/DeployPolygon deploy.

export const TimelockAbi = parseAbi([
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function EXECUTOR_ROLE() view returns (bytes32)",
  "function CANCELLER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function getMinDelay() view returns (uint256)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
  "function getOperationState(bytes32 id) view returns (uint8)",
  "function hashOperationBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) pure returns (bytes32)",
  "function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) payable",
  "function cancel(bytes32 id)",
]);

/** TimelockController.OperationState */
export const OPERATION_STATES = ["unset", "waiting", "ready", "done"] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

export const ZERO_BYTES32: Hex = `0x${"0".repeat(64)}`;

export interface BatchOperation {
  targets: Address[];
  payloads: Hex[];
  predecessor: Hex;
  salt: Hex;
}

/** values[] is always zeros: config setters are not payable. */
export function zeroValues(op: Pick<BatchOperation, "targets">): bigint[] {
  return op.targets.map(() => 0n);
}

/** Same as TimelockController.hashOperationBatch: keccak256(abi.encode(targets, values, payloads, predecessor, salt)). */
export function operationId(op: BatchOperation): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address[]" }, { type: "uint256[]" }, { type: "bytes[]" }, { type: "bytes32" }, { type: "bytes32" }],
      [op.targets, zeroValues(op), op.payloads, op.predecessor, op.salt]
    )
  );
}

/** 32 random bytes, so two identical changes never collide on the operation id. */
export function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function scheduleBatchData(op: BatchOperation, delay: bigint): Hex {
  return encodeFunctionData({
    abi: TimelockAbi,
    functionName: "scheduleBatch",
    args: [op.targets, zeroValues(op), op.payloads, op.predecessor, op.salt, delay],
  });
}

export function executeBatchData(op: BatchOperation): Hex {
  return encodeFunctionData({
    abi: TimelockAbi,
    functionName: "executeBatch",
    args: [op.targets, zeroValues(op), op.payloads, op.predecessor, op.salt],
  });
}

/**
 * Safe Transaction Builder file for a multisig Safe (mainnet): one transaction
 * to the timelock with the given calldata. Imported in the Safe{Wallet} app.
 */
export function safeTransactionBuilderJson(chainId: number, timelock: Address, data: Hex, name: string): string {
  return JSON.stringify(
    {
      version: "1.0",
      chainId: String(chainId),
      createdAt: Date.now(),
      meta: { name, description: "CHERR.IO admin console (TASK-034)" },
      transactions: [{ to: timelock, value: "0", data }],
    },
    null,
    2
  );
}

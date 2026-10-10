import {
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, custom, encodeFunctionData,
  UserRejectedRequestError, type Address, type EIP1193Provider, type Hash,
} from "viem";
import { EmergencyPoolAbi } from "@cherrio/contracts/abis";
import { polygonFees } from "@/lib/campaigns/publish-client";
import { errorText, type SendCalls } from "@/lib/campaigns/donate-client";

// Browser side of an Emergency Pool allocation vote (TASK-014c-2): voteAllocation
// (contributors of the pool) and closeAllocation ("Count the vote", anyone after
// the end). Simulated through the giver's own wallet first, so a refusal has a
// name before anything is signed; a CHERR.IO smart account sends the call as one
// sponsored user operation.

export type PoolVoteFailure =
  | "wrong_network"
  | "not_voting" // counted or decided already
  | "vote_ended"
  | "not_ended"
  | "already_voted"
  | "no_weight"
  | "rejected"
  | "sponsorship_refused"
  | "insufficient_gas"
  | "failed";

export class PoolVoteError extends Error {
  constructor(public readonly code: PoolVoteFailure) {
    super(code);
    this.name = "PoolVoteError";
  }
}

const REVERTS: Record<string, PoolVoteFailure> = {
  AllocationNotVoting: "not_voting",
  VoteEnded: "vote_ended",
  VoteNotEnded: "not_ended",
  AlreadyVoted: "already_voted",
  NoVotingWeight: "no_weight",
};

export function toPoolVoteFailure(error: unknown): PoolVoteFailure {
  if (error instanceof PoolVoteError) return error.code;
  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof UserRejectedRequestError)) return "rejected";
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) return REVERTS[revert.data?.errorName ?? ""] ?? "failed";
  }
  const e = error as { code?: unknown } | null;
  if (e && (e.code === 4001 || e.code === "ACTION_REJECTED")) return "rejected";
  const message = errorText(error);
  if (message.includes("user rejected") || message.includes("user denied")) return "rejected";
  if (/paymaster|gas manager|sponsor|policy|aa21|aa3\d/.test(message)) return "sponsorship_refused";
  if (message.includes("insufficient funds")) return "insufficient_gas";
  return "failed";
}

export type PoolVoteAction = { kind: "vote"; approve: boolean } | { kind: "count" };

export interface PoolVoteCall {
  chainId: number;
  pool: Address;
  allocationId: bigint;
  action: PoolVoteAction;
}

/** Simulates, then sends the vote (or the count). Returns the transaction hash. */
export async function sendPoolVote(
  provider: EIP1193Provider,
  account: Address,
  call: PoolVoteCall,
  sendCalls?: SendCalls
): Promise<Hash> {
  const read = createPublicClient({ transport: custom(provider, { retryCount: 0 }) });
  if ((await read.getChainId()) !== call.chainId) throw new PoolVoteError("wrong_network");
  const vote = call.action.kind === "vote";
  const approve = call.action.kind === "vote" && call.action.approve;
  if (vote) {
    await read.simulateContract({ address: call.pool, abi: EmergencyPoolAbi, functionName: "voteAllocation", args: [call.allocationId, approve], account });
  } else {
    await read.simulateContract({ address: call.pool, abi: EmergencyPoolAbi, functionName: "closeAllocation", args: [call.allocationId], account });
  }
  const data = vote
    ? encodeFunctionData({ abi: EmergencyPoolAbi, functionName: "voteAllocation", args: [call.allocationId, approve] })
    : encodeFunctionData({ abi: EmergencyPoolAbi, functionName: "closeAllocation", args: [call.allocationId] });
  if (sendCalls) return sendCalls([{ to: call.pool, data }]);
  const write = createWalletClient({ account, transport: custom(provider) });
  return write.sendTransaction({ to: call.pool, data, chain: null, ...(await polygonFees(provider)) });
}

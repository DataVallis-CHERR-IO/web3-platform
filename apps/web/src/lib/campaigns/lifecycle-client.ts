import {
  BaseError, ContractFunctionRevertedError, UserRejectedRequestError, createPublicClient, createWalletClient, custom,
  encodeFunctionData, type Address, type EIP1193Provider, type Hash, type PublicClient,
} from "viem";
import { CampaignAbi } from "@cherrio/contracts/abis";
import { polygonFeesFrom } from "./publish-client";
import { errorText, type SendCalls } from "./donate-client";

// Browser side of the campaign lifecycle (TASK-033b): vote, claimRefund,
// settleToPool, finalize, closeVote, release. Every action is first simulated
// from the sending account through a reader (the same-origin `/api/rpc` client
// in the app — the wallet's own RPC failed reads on Amoy, PR #73), so a call the
// contract would refuse never reaches the wallet and the refusal has a name.
// Then: smart account → one sponsored user operation through `sendCalls`;
// external wallet → `writeContract` with Polygon fees. The wallet only answers
// eth_chainId and signs. Pure logic, no React: unit-tested with a fake provider.
//
// Votes, refunds and pool settlements belong to the address that donated
// (ADR-008): the caller passes that address as `account` (for a CHERR.IO wallet,
// the smart account).

export type LifecycleAction =
  | { kind: "vote"; approve: boolean }
  | { kind: "claimRefund" }
  | { kind: "settleToPool"; donor: Address }
  | { kind: "finalize" }
  | { kind: "closeVote" }
  | { kind: "release" }
  /** Beneficiary only, PAYING (TASK-033c): the SHA-256 of the evidence manifest (ADR-047). */
  | { kind: "submitEvidence"; bundleHash: `0x${string}` };

export type LifecycleFailure =
  | "wrong_network"
  | "not_due" // deadline / vote end / release delay not reached yet
  | "already_done" // someone else finalized, closed, released or the state moved on
  | "vote_ended"
  | "already_voted"
  | "not_a_donor"
  | "already_settled"
  | "wrong_preference"
  | "swept"
  | "payout_mode_not_set"
  | "not_beneficiary"
  | "frozen"
  | "insufficient_gas"
  | "sponsorship_refused"
  | "rejected"
  | "reverted"
  | "failed";

export class LifecycleError extends Error {
  constructor(public readonly code: LifecycleFailure, options?: { cause?: unknown }) {
    super(code, options);
    this.name = "LifecycleError";
  }
}

/** Campaign.sol custom errors → what the user can do about them. */
const REVERTS: Record<string, LifecycleFailure> = {
  DeadlineNotReached: "not_due",
  VoteNotEnded: "not_due",
  ReleaseDelayNotReached: "not_due",
  NotLive: "already_done",
  NotSucceeded: "already_done",
  NotVoting: "already_done",
  NotFailedOrRejected: "already_done",
  VoteEnded: "vote_ended",
  AlreadyVoted: "already_voted",
  NotDonor: "not_a_donor",
  AlreadySettled: "already_settled",
  InvalidPreference: "wrong_preference",
  AlreadySwept: "swept",
  PayoutModeNotSet: "payout_mode_not_set",
  NotBeneficiary: "not_beneficiary",
  NotPaying: "already_done",
};

export function toLifecycleFailure(error: unknown): LifecycleFailure {
  if (error instanceof LifecycleError) return error.code;
  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof UserRejectedRequestError)) return "rejected";
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) return REVERTS[revert.data?.errorName ?? ""] ?? "reverted";
  }
  const e = error as { code?: unknown } | null;
  if (e && (e.code === 4001 || e.code === "ACTION_REJECTED")) return "rejected";
  const message = errorText(error);
  if (message.includes("user rejected") || message.includes("user denied")) return "rejected";
  if (/paymaster|gas manager|sponsor|policy|aa21|aa3\d/.test(message)) return "sponsorship_refused";
  if (message.includes("insufficient funds")) return "insufficient_gas";
  return "failed";
}

/** What the helpers read: simulation, fees, receipts. */
export type LifecycleReader = Pick<PublicClient, "simulateContract" | "readContract" | "getBlock" | "estimateMaxPriorityFeePerGas">;

function callOf(action: LifecycleAction): { functionName: string; args: readonly unknown[] } {
  switch (action.kind) {
    case "vote": return { functionName: "vote", args: [action.approve] };
    case "settleToPool": return { functionName: "settleToPool", args: [action.donor] };
    case "submitEvidence": return { functionName: "submitEvidence", args: [action.bundleHash] };
    default: return { functionName: action.kind, args: [] };
  }
}

/** Calldata of one lifecycle action (for a batch or a Safe). */
export function encodeLifecycle(action: LifecycleAction): `0x${string}` {
  const { functionName, args } = callOf(action);
  return encodeFunctionData({ abi: CampaignAbi, functionName: functionName as never, args: args as never });
}

const FROZEN = 8; // Campaign.CampaignState.FROZEN

/**
 * Simulates, then sends one lifecycle action from `account`. Returns the
 * transaction (or user-operation) hash.
 */
export async function sendLifecycle(
  provider: EIP1193Provider,
  account: Address,
  call: { chainId: number; campaign: Address; action: LifecycleAction },
  options: { reader?: LifecycleReader; sendCalls?: SendCalls } = {}
): Promise<Hash> {
  // No transport retries: a revert is final, and retrying it only delays the message by seconds.
  const wallet = createPublicClient({ transport: custom(provider, { retryCount: 0 }) });
  const read: LifecycleReader = options.reader ?? wallet;
  if ((await wallet.getChainId()) !== call.chainId) throw new LifecycleError("wrong_network");
  const { functionName, args } = callOf(call.action);
  try {
    await read.simulateContract({
      address: call.campaign, abi: CampaignAbi, functionName: functionName as never, args: args as never, account,
    });
  } catch (e) {
    // A frozen campaign refuses everything with the state's own error; say why.
    const state = await read.readContract({ address: call.campaign, abi: CampaignAbi, functionName: "state" }).catch(() => null);
    if (Number(state) === FROZEN) throw new LifecycleError("frozen", { cause: e });
    throw e;
  }
  if (options.sendCalls) return options.sendCalls([{ to: call.campaign, data: encodeLifecycle(call.action) }]);
  const write = createWalletClient({ account, transport: custom(provider) });
  return write.writeContract({
    address: call.campaign, abi: CampaignAbi, functionName: functionName as never, args: args as never,
    chain: null, ...(await polygonFeesFrom(read)),
  });
}

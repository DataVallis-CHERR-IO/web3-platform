import {
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, custom,
  type Address, type EIP1193Provider, type Hash, type Hex,
} from "viem";
import { EmergencyPoolAbi } from "@cherrio/contracts/abis";
import { polygonFeesFrom } from "@/lib/campaigns/publish-client";
import { LifecycleError, toLifecycleFailure, type LifecycleFailure, type LifecycleReader } from "@/lib/campaigns/lifecycle-client";

// Browser side of "Propose an allocation" (TASK-014c): proposeAllocation(poolId,
// campaign, amount, reasonHash) signed by the Operator's own wallet, simulated
// first through the reader (/api/rpc), so every refusal has a name before the
// wallet opens. Same shape as Admin → Emergency Pool sub-pools (TASK-046).

/** Refusals of proposeAllocation with their own message; the rest map like lifecycle calls. */
export type ProposeFailure =
  | LifecycleFailure
  | "pool_missing"
  | "campaign_not_live"
  | "not_factory_campaign"
  | "insufficient_pool_balance"
  | "deadline_too_soon"
  | "pool_mismatch"
  | "amount_zero";

const REVERTS: Record<string, ProposeFailure> = {
  NotOperator: "not_operator",
  PoolDoesNotExist: "pool_missing",
  NotLiveCampaign: "campaign_not_live",
  NotFactoryCampaign: "not_factory_campaign",
  InsufficientPoolBalance: "insufficient_pool_balance",
  CampaignDeadlineTooSoon: "deadline_too_soon",
  PoolIdMismatch: "pool_mismatch",
  AmountZero: "amount_zero",
};

export function toProposeFailure(error: unknown): ProposeFailure {
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const mapped = REVERTS[revert.data?.errorName ?? ""];
      if (mapped) return mapped;
    }
  }
  return toLifecycleFailure(error);
}

export interface ProposeCall {
  chainId: number;
  pool: Address;
  poolId: number;
  campaign: Address;
  /** USDC base units. */
  amount: bigint;
  reasonHash: Hex;
}

export async function sendProposeAllocation(
  provider: EIP1193Provider,
  account: Address,
  call: ProposeCall,
  options: { reader?: LifecycleReader } = {}
): Promise<Hash> {
  const wallet = createPublicClient({ transport: custom(provider, { retryCount: 0 }) });
  const read: LifecycleReader = options.reader ?? wallet;
  if ((await wallet.getChainId()) !== call.chainId) throw new LifecycleError("wrong_network");
  const request = {
    address: call.pool, abi: EmergencyPoolAbi, functionName: "proposeAllocation",
    args: [call.poolId, call.campaign, call.amount, call.reasonHash],
  } as const;
  await read.simulateContract({ ...request, account });
  const write = createWalletClient({ account, transport: custom(provider) });
  return write.writeContract({ ...request, chain: null, ...(await polygonFeesFrom(read)) });
}

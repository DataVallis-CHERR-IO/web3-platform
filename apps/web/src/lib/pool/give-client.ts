import { createPublicClient, createWalletClient, custom, encodeFunctionData, erc20Abi, type Address, type EIP1193Provider, type Hash } from "viem";
import { EmergencyPoolAbi, PlatformConfigAbi } from "@cherrio/contracts/abis";
import { polygonFees } from "@/lib/campaigns/publish-client";
import { approvalAmount, DonateError, type BatchCall, type SendCalls } from "@/lib/campaigns/donate-client";

// Browser side of "Give to this pool" (TASK-014b): EmergencyPool.donate(poolId,
// amount). The same rules as a campaign donation (donate-client.ts): every read
// through the giver's own wallet, approve exactly the amount (never unlimited),
// skip approve when the allowance covers it; a CHERR.IO smart account sends
// approve + donate as ONE sponsored user operation. A gift gives voting weight
// in that sub-pool for allocations proposed after it.

export interface GiveCall {
  chainId: number;
  pool: Address;
  poolId: number;
  /** USDC base units. */
  amount: bigint;
}

export type GiveStep = "checking" | "approving" | "donating";

interface Prepared {
  usdc: Address;
  needsApproval: boolean;
}

/** Chain, sub-pool on chain, minimum (PlatformConfig.minDonation), USDC balance; whether approve is needed. */
async function prepareGift(provider: EIP1193Provider, account: Address, call: GiveCall): Promise<Prepared> {
  const read = createPublicClient({ transport: custom(provider) });
  if ((await read.getChainId()) !== call.chainId) throw new DonateError("wrong_network");
  const [exists, config] = await Promise.all([
    read.readContract({ address: call.pool, abi: EmergencyPoolAbi, functionName: "poolExists", args: [call.poolId] }),
    read.readContract({ address: call.pool, abi: EmergencyPoolAbi, functionName: "config" }),
  ]);
  if (!exists) throw new DonateError("reverted");
  const [usdc, minDonation] = await Promise.all([
    read.readContract({ address: config, abi: PlatformConfigAbi, functionName: "usdc" }),
    read.readContract({ address: config, abi: PlatformConfigAbi, functionName: "minDonation" }),
  ]);
  if (call.amount < minDonation) throw new DonateError("below_minimum");
  const [balance, allowance] = await Promise.all([
    read.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    read.readContract({ address: usdc, abi: erc20Abi, functionName: "allowance", args: [account, call.pool] }),
  ]);
  if (balance < call.amount) throw new DonateError("insufficient_usdc");
  return { usdc, needsApproval: allowance < call.amount };
}

/** The calls of a gift: [approve(pool, exact)] only when needed, then donate(poolId, amount). */
export function giftCalls(call: GiveCall, prepared: Prepared): BatchCall[] {
  const calls: BatchCall[] = [];
  if (prepared.needsApproval) {
    calls.push({
      to: prepared.usdc,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [call.pool, approvalAmount(call.amount)] }),
    });
  }
  calls.push({
    to: call.pool,
    data: encodeFunctionData({ abi: EmergencyPoolAbi, functionName: "donate", args: [call.poolId, call.amount] }),
  });
  return calls;
}

/**
 * Gives from the giver's own wallet: checks, approve (if needed, waits for it),
 * then donate. With `sendCalls` (a CHERR.IO smart account) both go out as one
 * sponsored user operation instead. Returns the hash of the donate transaction.
 */
export async function giveToPool(
  provider: EIP1193Provider,
  account: Address,
  call: GiveCall,
  onStep: (step: GiveStep, detail?: { approveTx?: Hash }) => void = () => {},
  sendCalls?: SendCalls,
  receiptTimeoutMs = 180_000
): Promise<Hash> {
  onStep("checking");
  const prepared = await prepareGift(provider, account, call);
  if (sendCalls) {
    onStep("donating");
    return sendCalls(giftCalls(call, prepared));
  }
  const read = createPublicClient({ transport: custom(provider) });
  const write = createWalletClient({ account, transport: custom(provider) });
  if (prepared.needsApproval) {
    onStep("approving");
    const approveTx = await write.writeContract({
      address: prepared.usdc, abi: erc20Abi, functionName: "approve", args: [call.pool, approvalAmount(call.amount)],
      chain: null, ...(await polygonFees(provider)),
    });
    onStep("approving", { approveTx });
    const receipt = await read.waitForTransactionReceipt({ hash: approveTx, timeout: receiptTimeoutMs, pollingInterval: 3_000 });
    if (receipt.status !== "success") throw new DonateError("reverted");
  }
  onStep("donating");
  return write.writeContract({
    address: call.pool, abi: EmergencyPoolAbi, functionName: "donate", args: [call.poolId, call.amount],
    chain: null, ...(await polygonFees(provider)),
  });
}

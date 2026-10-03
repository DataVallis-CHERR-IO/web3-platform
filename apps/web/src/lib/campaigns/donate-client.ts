import {
  BaseError, ContractFunctionRevertedError, UserRejectedRequestError, createPublicClient, createWalletClient, custom,
  erc20Abi, type Address, type EIP1193Provider, type Hash,
} from "viem";
import { CampaignAbi, PlatformConfigAbi } from "@cherrio/contracts/abis";
import { polygonFees } from "./publish-client";

// Browser side of a donation (TASK-011b). Runs against the donor's own wallet
// provider (EIP-1193, through Privy), so every read and write goes through the
// wallet and the web app needs no RPC key. Pure logic, no React: unit-tested with
// a fake provider (`donate-client.test.ts`).
//
// Rules: approve the exact amount the campaign will take — never an unlimited
// allowance; skip approve when the allowance already covers it; Polygon fees
// with a 30 gwei minimum tip (`polygonFees`).

/** Campaign.CampaignState.LIVE */
const STATE_LIVE = 0;

/** Failure preference: what happens to the money if the campaign fails. */
export type FailurePreference = { kind: "REFUND" } | { kind: "EMERGENCY_POOL"; subPoolId: number };

export function preferenceArgs(pref: FailurePreference): [number, number] {
  return pref.kind === "REFUND" ? [0, 0] : [1, pref.subPoolId];
}

export type DonateFailure =
  | "wrong_network"
  | "campaign_ended"
  | "below_minimum"
  | "insufficient_usdc"
  | "insufficient_gas"
  | "not_a_donor"
  | "rejected"
  | "timeout"
  | "reverted"
  | "failed";

/** A check before or during sending failed; `code` maps to a fixable message. */
export class DonateError extends Error {
  constructor(public readonly code: DonateFailure, options?: { cause?: unknown }) {
    super(code, options);
    this.name = "DonateError";
  }
}

export interface DonateCall {
  chainId: number;
  campaign: Address;
  /** Passed to donate(); the contract checks the minimum against it. */
  send: bigint;
  preference: FailurePreference;
}

export type DonateStep = "checking" | "approving" | "donating";

/**
 * The allowance a donation asks for: exactly what the campaign will take.
 * Kept as its own function so a test pins it (an unlimited approve must fail).
 */
export function approvalAmount(willTake: bigint): bigint {
  return willTake;
}

const clients = (provider: EIP1193Provider, account: Address) => ({
  read: createPublicClient({ transport: custom(provider) }),
  write: createWalletClient({ account, transport: custom(provider) }),
});

/** Maps anything a wallet or node throws to a DonateFailure. */
export function toDonateFailure(error: unknown): DonateFailure {
  if (error instanceof DonateError) return error.code;
  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof UserRejectedRequestError)) return "rejected";
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      if (name === "NotLive" || name === "PastDeadline") return "campaign_ended";
      if (name === "AmountTooLow") return "below_minimum";
      if (name === "NotDonor") return "not_a_donor";
      return "reverted";
    }
  }
  const e = error as { code?: unknown; message?: unknown } | null;
  if (e && (e.code === 4001 || e.code === "ACTION_REJECTED")) return "rejected";
  const message = typeof e?.message === "string" ? e.message.toLowerCase() : "";
  if (message.includes("user rejected") || message.includes("user denied")) return "rejected";
  if (message.includes("insufficient funds")) return "insufficient_gas";
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  return "failed";
}

async function checkLive(read: ReturnType<typeof clients>["read"], campaign: Address) {
  const [state, deadline] = await Promise.all([
    read.readContract({ address: campaign, abi: CampaignAbi, functionName: "state" }),
    read.readContract({ address: campaign, abi: CampaignAbi, functionName: "deadline" }),
  ]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (Number(state) !== STATE_LIVE || BigInt(deadline) <= now) throw new DonateError("campaign_ended");
}

/**
 * Checks and sends a donation:
 * 1. the wallet is on the campaign's chain;
 * 2. the campaign is LIVE and before its deadline;
 * 3. the amount meets PlatformConfig.minDonation; what will be taken = min(send, remaining());
 * 4. the wallet holds that much USDC;
 * 5. approve(campaign, exact amount) if the allowance is lower — waits for it;
 * 6. donate(send, pref, subPoolId).
 * Returns the donate transaction hash and the amount the campaign takes.
 */
export async function donate(
  provider: EIP1193Provider,
  account: Address,
  call: DonateCall,
  onStep: (step: DonateStep, detail?: { approveTx?: Hash }) => void = () => {},
  receiptTimeoutMs = 180_000
): Promise<{ txHash: Hash; willTake: bigint }> {
  const { read, write } = clients(provider, account);
  onStep("checking");
  if ((await read.getChainId()) !== call.chainId) throw new DonateError("wrong_network");
  await checkLive(read, call.campaign);

  const config = await read.readContract({ address: call.campaign, abi: CampaignAbi, functionName: "config" });
  const [usdc, minDonation, remaining] = await Promise.all([
    read.readContract({ address: config, abi: PlatformConfigAbi, functionName: "usdc" }),
    read.readContract({ address: config, abi: PlatformConfigAbi, functionName: "minDonation" }),
    read.readContract({ address: call.campaign, abi: CampaignAbi, functionName: "remaining" }),
  ]);
  if (remaining === 0n) throw new DonateError("campaign_ended");
  if (call.send < minDonation) throw new DonateError("below_minimum");
  const willTake = call.send > remaining ? remaining : call.send;

  const [balance, allowance] = await Promise.all([
    read.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    read.readContract({ address: usdc, abi: erc20Abi, functionName: "allowance", args: [account, call.campaign] }),
  ]);
  if (balance < willTake) throw new DonateError("insufficient_usdc");

  if (allowance < willTake) {
    onStep("approving");
    const approveTx = await write.writeContract({
      address: usdc, abi: erc20Abi, functionName: "approve", args: [call.campaign, approvalAmount(willTake)],
      chain: null, ...(await polygonFees(provider)),
    });
    onStep("approving", { approveTx });
    const receipt = await read.waitForTransactionReceipt({ hash: approveTx, timeout: receiptTimeoutMs, pollingInterval: 3_000 });
    if (receipt.status !== "success") throw new DonateError("reverted");
  }

  onStep("donating");
  const [pref, subPoolId] = preferenceArgs(call.preference);
  const txHash = await write.writeContract({
    address: call.campaign, abi: CampaignAbi, functionName: "donate", args: [call.send, pref, subPoolId],
    chain: null, ...(await polygonFees(provider)),
  });
  return { txHash, willTake };
}

/** Changes the failure preference of an existing donor while the campaign is LIVE. */
export async function changePreference(
  provider: EIP1193Provider,
  account: Address,
  call: { chainId: number; campaign: Address; preference: FailurePreference }
): Promise<Hash> {
  const { read, write } = clients(provider, account);
  if ((await read.getChainId()) !== call.chainId) throw new DonateError("wrong_network");
  await checkLive(read, call.campaign);
  const donated = await read.readContract({ address: call.campaign, abi: CampaignAbi, functionName: "donated", args: [account] });
  if (donated === 0n) throw new DonateError("not_a_donor");
  const [pref, subPoolId] = preferenceArgs(call.preference);
  return write.writeContract({
    address: call.campaign, abi: CampaignAbi, functionName: "setPreference", args: [pref, subPoolId],
    chain: null, ...(await polygonFees(provider)),
  });
}

/** Waits for a transaction through the wallet's provider. true = mined and succeeded. */
export async function waitForTx(provider: EIP1193Provider, txHash: Hash, timeoutMs = 180_000): Promise<boolean> {
  const read = createPublicClient({ transport: custom(provider) });
  const receipt = await read.waitForTransactionReceipt({ hash: txHash, timeout: timeoutMs, pollingInterval: 3_000 });
  return receipt.status === "success";
}

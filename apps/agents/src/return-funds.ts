/**
 * apps/agents/src/return-funds.ts — payouts go back to the treasury (TASK-061g, part B).
 *
 * A crew fundraiser is the payout wallet of its campaigns, so after a payout it
 * holds test USDC. This sends all of it to the treasury (crew index 0) so the
 * same test money circulates. Node side only, no browser: the transfer goes
 * through the signer policy (`checkTransaction`, "USDC transfer inside the
 * crew") and the existing sender, exactly like a top-up.
 */
import { BudgetExceeded } from "./budget.js";
import { encodeFunctionData, erc20Abi, formatUnits, type Hash } from "viem";
import type { Chain } from "./chain.js";
import { policyFor, senderFor } from "./chain.js";
import type { CrewMember } from "./crew.js";
import { checkTransaction, type TxRequest } from "./policy.js";
import type { RecordStep } from "./browser.js";

/** Below this (5 USDC, 6 decimals) the wallet keeps its balance: not worth a transaction. */
export const RETURN_MIN_USDC = 5_000_000n;

export interface ReturnOptions {
  rpcUrl: string;
  /** Called before the send (budget: "transactions"); throwing stops it. */
  beforeSend?: (tx: TxRequest) => void;
  /** Test seam; default is the member's own sender. */
  send?: (tx: TxRequest) => Promise<Hash>;
  /** Test seam: a treasury address other than the crew's index 0 (the policy must then refuse it). */
  treasuryAddress?: `0x${string}`;
  /** Receipt polling interval in ms (tests use a small one). */
  pollingInterval?: number;
}

export type ReturnResult = "returned" | "skipped" | "failed";

/** Pure: should this member send its balance back, and how much? */
export function returnPlan(member: Pick<CrewMember, "persona">, balance: bigint, min: bigint = RETURN_MIN_USDC): bigint {
  if (member.persona !== "fundraiser") return 0n;
  return balance >= min ? balance : 0n;
}

export async function returnFunds(
  chain: Chain, crew: CrewMember[], member: CrewMember, record: RecordStep, o: ReturnOptions
): Promise<ReturnResult> {
  const step = "return funds";
  const treasury = crew.find((m) => m.persona === "treasury");
  if (member.persona !== "fundraiser") return "skipped"; // nothing is recorded for other personas
  const to = o.treasuryAddress ?? treasury?.address;
  if (!to || to === member.address) return "skipped";
  const balance = (await chain.client.readContract({ address: chain.usdc, abi: erc20Abi, functionName: "balanceOf", args: [member.address] })) as bigint;
  const amount = returnPlan(member, balance);
  if (amount === 0n) {
    record(step, true, `skipped — ${formatUnits(balance, 6)} USDC is below ${formatUnits(RETURN_MIN_USDC, 6)}`, { report: false });
    return "skipped";
  }
  const tx: TxRequest = { to: chain.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) };
  const verdict = await checkTransaction(tx, policyFor(member, crew, chain));
  if (!verdict.ok) {
    record(step, false, `policy refused sending ${formatUnits(amount, 6)} USDC to the treasury: ${verdict.reason}`);
    return "failed";
  }
  try {
    o.beforeSend?.(tx);
    const hash = await (o.send ?? senderFor(member, o.rpcUrl))(tx);
    const receipt = await chain.client.waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: o.pollingInterval ?? 3_000 });
    if (receipt.status !== "success") {
      record(step, false, `transfer of ${formatUnits(amount, 6)} USDC to the treasury reverted`, { txHashes: [hash] });
      return "failed";
    }
    record(step, true, `${member.name} returned ${formatUnits(amount, 6)} USDC to the treasury`, { txHashes: [hash] });
    return "returned";
  } catch (error) {
    // The run's budget stops the run, not this step (review of TASK-061g).
    if (error instanceof BudgetExceeded) throw error;
    record(step, false, `sending ${formatUnits(amount, 6)} USDC to the treasury failed: ${error instanceof Error ? error.message.slice(0, 160) : "error"}`);
    return "failed";
  }
}

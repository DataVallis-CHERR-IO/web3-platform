import { describe, expect, it } from "vitest";
import {
  decodeFunctionData, encodeFunctionResult, erc20Abi, getAddress, maxUint256, UserRejectedRequestError, zeroAddress,
  type Address, type EIP1193Provider, type Hex,
} from "viem";
import { EmergencyPoolAbi, PlatformConfigAbi } from "@cherrio/contracts/abis";
import { DonateError, toDonateFailure, type BatchCall } from "@/lib/campaigns/donate-client";
import { giveToPool, type GiveStep } from "@/lib/pool/give-client";

// "Give to this pool" (TASK-014b) against a fake EIP-1193 provider: reads are
// answered like EmergencyPool / PlatformConfig / USDC, sent transactions decoded.

const POOL = getAddress("0x3333333333333333333333333333333333333333");
const CONFIG = getAddress("0x2222222222222222222222222222222222222222");
const USDC = getAddress("0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582");
const GIVER = getAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
const TX: Hex = `0x${"cd".repeat(32)}`;
const U = 1_000_000n;

interface World {
  chainId?: number;
  exists?: boolean;
  minDonation?: bigint;
  balance?: bigint;
  allowance?: bigint;
  receiptStatus?: "0x1" | "0x0";
  rejectSend?: boolean;
}

function fakeProvider(world: World = {}) {
  const sent: { to: Address; fn: string; args: readonly unknown[]; maxPriorityFeePerGas?: Hex }[] = [];
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      switch (method) {
        case "eth_chainId":
          return `0x${(world.chainId ?? 80002).toString(16)}`;
        case "eth_call": {
          const { to, data } = params![0] as { to: string; data: Hex };
          const target = getAddress(to);
          if (target === POOL) {
            const call = decodeFunctionData({ abi: EmergencyPoolAbi, data });
            if (call.functionName === "poolExists")
              return encodeFunctionResult({ abi: EmergencyPoolAbi, functionName: "poolExists", result: world.exists ?? true });
            if (call.functionName === "config") return encodeFunctionResult({ abi: EmergencyPoolAbi, functionName: "config", result: CONFIG });
          }
          if (target === CONFIG) {
            const call = decodeFunctionData({ abi: PlatformConfigAbi, data });
            if (call.functionName === "usdc") return encodeFunctionResult({ abi: PlatformConfigAbi, functionName: "usdc", result: USDC });
            if (call.functionName === "minDonation")
              return encodeFunctionResult({ abi: PlatformConfigAbi, functionName: "minDonation", result: world.minDonation ?? U });
          }
          if (target === USDC) {
            const call = decodeFunctionData({ abi: erc20Abi, data });
            if (call.functionName === "balanceOf")
              return encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: world.balance ?? 1_000n * U });
            if (call.functionName === "allowance")
              return encodeFunctionResult({ abi: erc20Abi, functionName: "allowance", result: world.allowance ?? 0n });
          }
          throw new Error(`unexpected eth_call to ${to}`);
        }
        case "eth_getBlockByNumber":
          return { number: "0x10", hash: `0x${"11".repeat(32)}`, parentHash: `0x${"22".repeat(32)}`, timestamp: "0x6a0f0000",
                   baseFeePerGas: "0x" + (40n * 10n ** 9n).toString(16), gasLimit: "0x1c9c380", gasUsed: "0x0",
                   transactions: [], uncles: [], nonce: "0x0000000000000000", difficulty: "0x0", logsBloom: "0x" + "00".repeat(256),
                   miner: zeroAddress, extraData: "0x", size: "0x1", stateRoot: `0x${"33".repeat(32)}`, receiptsRoot: `0x${"44".repeat(32)}`,
                   transactionsRoot: `0x${"55".repeat(32)}`, sha3Uncles: `0x${"66".repeat(32)}`, mixHash: `0x${"77".repeat(32)}` };
        case "eth_maxPriorityFeePerGas":
          return "0x" + 1_500_000_000n.toString(16);
        case "eth_sendTransaction": {
          if (world.rejectSend) throw new UserRejectedRequestError(new Error("User rejected the request."));
          const tx = params![0] as { to: Address; data: Hex; maxPriorityFeePerGas?: Hex };
          const abi = getAddress(tx.to) === USDC ? erc20Abi : EmergencyPoolAbi;
          const call = decodeFunctionData({ abi: abi as typeof EmergencyPoolAbi, data: tx.data });
          sent.push({ to: getAddress(tx.to), fn: call.functionName, args: call.args ?? [], maxPriorityFeePerGas: tx.maxPriorityFeePerGas });
          return TX;
        }
        case "eth_getTransactionReceipt":
          return { transactionHash: params![0], status: world.receiptStatus ?? "0x1", blockNumber: "0x10", blockHash: `0x${"11".repeat(32)}`,
                   transactionIndex: "0x0", from: GIVER, to: USDC, cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1",
                   logs: [], logsBloom: "0x" + "00".repeat(256), type: "0x2", contractAddress: null };
        case "eth_blockNumber":
          return "0x10";
        case "eth_getTransactionByHash":
          return null;
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  } as unknown as EIP1193Provider;
  return { provider, sent };
}

const gift = (amount: bigint, poolId = 3) => ({ chainId: 80002, pool: POOL, poolId, amount });
const failure = (promise: Promise<unknown>) => promise.then(() => "resolved", (e: unknown) => toDonateFailure(e));

describe("give to a sub-pool (TASK-014b)", () => {
  it("approves exactly the amount to the pool, then donate(poolId, amount)", async () => {
    const { provider, sent } = fakeProvider();
    const steps: GiveStep[] = [];
    expect(await giveToPool(provider, GIVER, gift(25n * U), (s) => steps.push(s))).toBe(TX);
    expect(sent.map((s) => [s.to, s.fn])).toEqual([[USDC, "approve"], [POOL, "donate"]]);
    expect(sent[0]!.args).toEqual([POOL, 25n * U]);
    expect(sent[0]!.args[1]).not.toBe(maxUint256);
    expect(sent[1]!.args).toEqual([3, 25n * U]);
    expect(steps).toEqual(["checking", "approving", "approving", "donating"]);
    expect(BigInt(sent[1]!.maxPriorityFeePerGas!)).toBeGreaterThanOrEqual(30_000_000_000n);
  });

  it("skips approve when the allowance covers the amount", async () => {
    const { provider, sent } = fakeProvider({ allowance: 25n * U });
    await giveToPool(provider, GIVER, gift(25n * U));
    expect(sent.map((s) => s.fn)).toEqual(["donate"]);
  });

  it("a CHERR.IO smart account sends approve + donate as one batch and signs nothing itself", async () => {
    const { provider, sent } = fakeProvider();
    const batches: BatchCall[][] = [];
    const tx = await giveToPool(provider, GIVER, gift(5n * U, 0), () => {}, async (calls) => {
      batches.push(calls);
      return `0x${"ef".repeat(32)}`;
    });
    expect(tx).toBe(`0x${"ef".repeat(32)}`);
    expect(sent).toEqual([]);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((c) => c.to)).toEqual([USDC, POOL]);
    expect(decodeFunctionData({ abi: erc20Abi, data: batches[0]![0]!.data }).args).toEqual([POOL, 5n * U]);
    expect(decodeFunctionData({ abi: EmergencyPoolAbi, data: batches[0]![1]!.data })).toMatchObject({ functionName: "donate", args: [0, 5n * U] });
  });

  it("refuses before sending: wrong network, unknown sub-pool, below the minimum, not enough USDC", async () => {
    for (const [world, amount, code] of [
      [{ chainId: 1 }, 5n * U, "wrong_network"],
      [{ exists: false }, 5n * U, "reverted"],
      [{ minDonation: 2n * U }, U, "below_minimum"],
      [{ balance: 4n * U }, 5n * U, "insufficient_usdc"],
    ] as const) {
      const { provider, sent } = fakeProvider(world);
      expect(await failure(giveToPool(provider, GIVER, gift(amount)))).toBe(code);
      expect(sent).toEqual([]);
    }
  });

  it("a cancelled wallet and a reverted approve are reported, donate is never sent after a failed approve", async () => {
    const rejected = fakeProvider({ rejectSend: true });
    expect(await failure(giveToPool(rejected.provider, GIVER, gift(5n * U)))).toBe("rejected");
    const reverted = fakeProvider({ receiptStatus: "0x0" });
    await expect(giveToPool(reverted.provider, GIVER, gift(5n * U))).rejects.toBeInstanceOf(DonateError);
    expect(reverted.sent.map((s) => s.fn)).toEqual(["approve"]);
  });
});

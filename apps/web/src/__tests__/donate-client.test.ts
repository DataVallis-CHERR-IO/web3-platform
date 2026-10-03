import { describe, expect, it } from "vitest";
import {
  decodeFunctionData, encodeFunctionResult, erc20Abi, getAddress, maxUint256, UserRejectedRequestError, zeroAddress,
  type Address, type EIP1193Provider, type Hex,
} from "viem";
import { CampaignAbi, PlatformConfigAbi } from "@cherrio/contracts/abis";
import {
  approvalAmount, changePreference, donate, DonateError, donateWithSmartAccount, toDonateFailure,
  type BatchCall, type DonateStep,
} from "@/lib/campaigns/donate-client";

// The browser side of a donation against a fake EIP-1193 provider: reads are
// answered like the real contracts, sent transactions are decoded and recorded.

const CAMPAIGN = getAddress("0x1111111111111111111111111111111111111111");
const CONFIG = getAddress("0x2222222222222222222222222222222222222222");
const USDC = getAddress("0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582");
const DONOR = getAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
const TX: Hex = `0x${"cd".repeat(32)}`;
const USDC_UNIT = 1_000_000n;

interface World {
  chainId?: number;
  state?: number;
  deadline?: bigint;
  remaining?: bigint;
  minDonation?: bigint;
  balance?: bigint;
  allowance?: bigint;
  donated?: bigint;
  receiptStatus?: "0x1" | "0x0";
  rejectSend?: boolean;
}

interface Sent {
  to: Address;
  fn: string;
  args: readonly unknown[];
  maxPriorityFeePerGas?: Hex;
}

function fakeProvider(world: World = {}) {
  const sent: Sent[] = [];
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      switch (method) {
        case "eth_chainId":
          return `0x${(world.chainId ?? 80002).toString(16)}`;
        case "eth_call": {
          const { to, data } = params![0] as { to: string; data: Hex };
          const target = getAddress(to);
          if (target === CAMPAIGN) {
            const call = decodeFunctionData({ abi: CampaignAbi, data });
            const answer = (functionName: string, result: unknown) =>
              encodeFunctionResult({ abi: CampaignAbi, functionName: functionName as never, result: result as never });
            switch (call.functionName) {
              case "state": return answer("state", world.state ?? 0);
              case "deadline": return answer("deadline", world.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 86_400));
              case "config": return answer("config", CONFIG);
              case "remaining": return answer("remaining", world.remaining ?? 500n * USDC_UNIT);
              case "donated": return answer("donated", world.donated ?? 0n);
            }
          }
          if (target === CONFIG) {
            const call = decodeFunctionData({ abi: PlatformConfigAbi, data });
            if (call.functionName === "usdc") return encodeFunctionResult({ abi: PlatformConfigAbi, functionName: "usdc", result: USDC });
            if (call.functionName === "minDonation")
              return encodeFunctionResult({ abi: PlatformConfigAbi, functionName: "minDonation", result: world.minDonation ?? USDC_UNIT });
          }
          if (target === USDC) {
            const call = decodeFunctionData({ abi: erc20Abi, data });
            if (call.functionName === "balanceOf")
              return encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: world.balance ?? 1_000n * USDC_UNIT });
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
          const abi = getAddress(tx.to) === USDC ? erc20Abi : CampaignAbi;
          const call = decodeFunctionData({ abi: abi as typeof CampaignAbi, data: tx.data });
          sent.push({ to: getAddress(tx.to), fn: call.functionName, args: call.args ?? [], maxPriorityFeePerGas: tx.maxPriorityFeePerGas });
          return TX;
        }
        case "eth_getTransactionReceipt":
          return { transactionHash: params![0], status: world.receiptStatus ?? "0x1", blockNumber: "0x10", blockHash: `0x${"11".repeat(32)}`,
                   transactionIndex: "0x0", from: DONOR, to: USDC, cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1",
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

const call = (send: bigint, pref: Parameters<typeof donate>[2]["preference"] = { kind: "REFUND" }) => ({
  chainId: 80002, campaign: CAMPAIGN, send, preference: pref,
});

describe("donate (TASK-011b)", () => {
  it("approves the exact amount, then donates with the preference", async () => {
    const { provider, sent } = fakeProvider();
    const steps: DonateStep[] = [];
    const result = await donate(provider, DONOR, call(25n * USDC_UNIT), (s) => steps.push(s));
    expect(result).toEqual({ txHash: TX, willTake: 25n * USDC_UNIT });
    expect(sent.map((s) => s.fn)).toEqual(["approve", "donate"]);
    expect(sent[0]).toMatchObject({ to: USDC, args: [CAMPAIGN, 25n * USDC_UNIT] });
    expect(sent[0]!.args[1]).not.toBe(maxUint256);
    expect(sent[1]).toMatchObject({ to: CAMPAIGN, args: [25n * USDC_UNIT, 0, 0] });
    expect(steps).toEqual(["checking", "approving", "approving", "donating"]);
    // Polygon rejects tips below 25 gwei; we send at least 30 gwei.
    expect(BigInt(sent[1]!.maxPriorityFeePerGas!)).toBeGreaterThanOrEqual(30_000_000_000n);
  });

  it("skips approve when the allowance already covers the amount", async () => {
    const { provider, sent } = fakeProvider({ allowance: 25n * USDC_UNIT });
    await donate(provider, DONOR, call(25n * USDC_UNIT));
    expect(sent.map((s) => s.fn)).toEqual(["donate"]);
  });

  it("clips the approval to remaining() but passes the typed amount to donate()", async () => {
    const { provider, sent } = fakeProvider({ remaining: 7n * USDC_UNIT });
    const result = await donate(provider, DONOR, call(50n * USDC_UNIT));
    expect(result.willTake).toBe(7n * USDC_UNIT);
    expect(sent[0]!.args).toEqual([CAMPAIGN, 7n * USDC_UNIT]);
    expect(sent[1]!.args).toEqual([50n * USDC_UNIT, 0, 0]);
  });

  it("sends the Emergency Pool preference with its sub-pool", async () => {
    const { provider, sent } = fakeProvider({ allowance: maxUint256 });
    await donate(provider, DONOR, call(5n * USDC_UNIT, { kind: "EMERGENCY_POOL", subPoolId: 2 }));
    expect(sent[0]!.args).toEqual([5n * USDC_UNIT, 1, 2]);
  });

  it("never asks for an unlimited allowance", () => {
    expect(approvalAmount(12n * USDC_UNIT)).toBe(12n * USDC_UNIT);
    expect(approvalAmount(1n)).not.toBe(maxUint256);
  });

  it.each<[string, World, bigint, string]>([
    ["wrong network", { chainId: 137 }, 5n * USDC_UNIT, "wrong_network"],
    ["campaign not live", { state: 1 }, 5n * USDC_UNIT, "campaign_ended"],
    ["deadline passed", { deadline: 1n }, 5n * USDC_UNIT, "campaign_ended"],
    ["target reached", { remaining: 0n }, 5n * USDC_UNIT, "campaign_ended"],
    ["below the on-chain minimum", { minDonation: 10n * USDC_UNIT }, 5n * USDC_UNIT, "below_minimum"],
    ["not enough USDC", { balance: 4n * USDC_UNIT }, 5n * USDC_UNIT, "insufficient_usdc"],
  ])("refuses before sending: %s", async (_name, world, send, code) => {
    const { provider, sent } = fakeProvider(world);
    await expect(donate(provider, DONOR, call(send))).rejects.toMatchObject({ code });
    expect(sent).toHaveLength(0);
  });

  it("stops when the approve transaction fails", async () => {
    const { provider, sent } = fakeProvider({ receiptStatus: "0x0" });
    await expect(donate(provider, DONOR, call(5n * USDC_UNIT))).rejects.toMatchObject({ code: "reverted" });
    expect(sent.map((s) => s.fn)).toEqual(["approve"]);
  });

  it("maps a rejection in the wallet", async () => {
    const { provider } = fakeProvider({ rejectSend: true });
    const error = await donate(provider, DONOR, call(5n * USDC_UNIT)).catch((e: unknown) => e);
    expect(toDonateFailure(error)).toBe("rejected");
  });
});

/** A fake Privy smart-wallet client: records each batch, never touches the read provider. */
function fakeSmartAccount(fail?: unknown) {
  const batches: { to: Address; fn: string; args: readonly unknown[] }[][] = [];
  const sendCalls = async (calls: BatchCall[]) => {
    if (fail) throw fail;
    batches.push(calls.map((c) => {
      const abi = getAddress(c.to) === USDC ? erc20Abi : CampaignAbi;
      const decoded = decodeFunctionData({ abi: abi as typeof CampaignAbi, data: c.data });
      return { to: getAddress(c.to), fn: decoded.functionName, args: decoded.args ?? [] };
    }));
    return TX;
  };
  return { sendCalls, batches };
}

describe("donateWithSmartAccount (TASK-011c)", () => {
  it("sends approve(exact) + donate as ONE batch and signs nothing through the wallet provider", async () => {
    const { provider, sent } = fakeProvider();
    const smart = fakeSmartAccount();
    const steps: DonateStep[] = [];
    const result = await donateWithSmartAccount(provider, DONOR, smart.sendCalls, call(25n * USDC_UNIT), (s) => steps.push(s));
    expect(result).toEqual({ txHash: TX, willTake: 25n * USDC_UNIT });
    expect(smart.batches).toHaveLength(1);
    expect(smart.batches[0]).toEqual([
      { to: USDC, fn: "approve", args: [CAMPAIGN, 25n * USDC_UNIT] },
      { to: CAMPAIGN, fn: "donate", args: [25n * USDC_UNIT, 0, 0] },
    ]);
    expect(smart.batches[0]![0]!.args[1]).not.toBe(maxUint256);
    expect(sent).toHaveLength(0);
    expect(steps).toEqual(["checking", "donating"]);
  });

  it("leaves approve out of the batch when the allowance covers it", async () => {
    const { provider } = fakeProvider({ allowance: 25n * USDC_UNIT });
    const smart = fakeSmartAccount();
    await donateWithSmartAccount(provider, DONOR, smart.sendCalls, call(25n * USDC_UNIT, { kind: "EMERGENCY_POOL", subPoolId: 3 }));
    expect(smart.batches[0]).toEqual([{ to: CAMPAIGN, fn: "donate", args: [25n * USDC_UNIT, 1, 3] }]);
  });

  it("clips the approval to remaining() but passes the typed amount to donate()", async () => {
    const { provider } = fakeProvider({ remaining: 7n * USDC_UNIT });
    const smart = fakeSmartAccount();
    const result = await donateWithSmartAccount(provider, DONOR, smart.sendCalls, call(50n * USDC_UNIT));
    expect(result.willTake).toBe(7n * USDC_UNIT);
    expect(smart.batches[0]!.map((c) => c.args)).toEqual([[CAMPAIGN, 7n * USDC_UNIT], [50n * USDC_UNIT, 0, 0]]);
  });

  it.each<[string, World, string]>([
    ["wrong network", { chainId: 137 }, "wrong_network"],
    ["campaign not live", { state: 1 }, "campaign_ended"],
    ["below the on-chain minimum", { minDonation: 10n * USDC_UNIT }, "below_minimum"],
    ["not enough USDC in the smart account", { balance: 4n * USDC_UNIT }, "insufficient_usdc"],
  ])("refuses before sending: %s", async (_name, world, code) => {
    const { provider } = fakeProvider(world);
    const smart = fakeSmartAccount();
    await expect(donateWithSmartAccount(provider, DONOR, smart.sendCalls, call(5n * USDC_UNIT))).rejects.toMatchObject({ code });
    expect(smart.batches).toHaveLength(0);
  });

  it("reports a refused sponsorship plainly", async () => {
    const { provider } = fakeProvider();
    const refused = Object.assign(new Error("Request failed"), {
      cause: { message: "pm_getPaymasterStubData: Policy limit exceeded for sender" },
    });
    const error = await donateWithSmartAccount(provider, DONOR, fakeSmartAccount(refused).sendCalls, call(5n * USDC_UNIT)).catch((e: unknown) => e);
    expect(toDonateFailure(error)).toBe("sponsorship_refused");
  });
});

describe("toDonateFailure", () => {
  it.each<[unknown, string]>([
    [new Error("UserOperation reverted: AA21 didn't pay prefund"), "sponsorship_refused"],
    [new Error("Gas Manager policy rejected the request"), "sponsorship_refused"],
    [new DonateError("insufficient_usdc"), "insufficient_usdc"],
    [{ code: 4001, message: "User denied transaction signature" }, "rejected"],
    [new Error("insufficient funds for gas * price + value"), "insufficient_gas"],
    [new Error("Timed out while waiting for transaction"), "timeout"],
    [new Error("something else"), "failed"],
    [null, "failed"],
  ])("%s → %s", (error, code) => {
    expect(toDonateFailure(error)).toBe(code);
  });
});

describe("changePreference", () => {
  it("calls setPreference for an existing donor", async () => {
    const { provider, sent } = fakeProvider({ donated: 5n * USDC_UNIT });
    const hash = await changePreference(provider, DONOR, {
      chainId: 80002, campaign: CAMPAIGN, preference: { kind: "EMERGENCY_POOL", subPoolId: 0 },
    });
    expect(hash).toBe(TX);
    expect(sent).toEqual([expect.objectContaining({ to: CAMPAIGN, fn: "setPreference", args: [1, 0] })]);
  });

  it("sends setPreference as a sponsored batch for a smart account", async () => {
    const { provider, sent } = fakeProvider({ donated: 5n * USDC_UNIT });
    const smart = fakeSmartAccount();
    const hash = await changePreference(
      provider, DONOR, { chainId: 80002, campaign: CAMPAIGN, preference: { kind: "REFUND" } }, smart.sendCalls
    );
    expect(hash).toBe(TX);
    expect(smart.batches).toEqual([[{ to: CAMPAIGN, fn: "setPreference", args: [0, 0] }]]);
    expect(sent).toHaveLength(0);
  });

  it("refuses for an address that has not donated", async () => {
    const { provider, sent } = fakeProvider({ donated: 0n });
    await expect(
      changePreference(provider, DONOR, { chainId: 80002, campaign: CAMPAIGN, preference: { kind: "REFUND" } })
    ).rejects.toMatchObject({ code: "not_a_donor" });
    expect(sent).toHaveLength(0);
  });
});

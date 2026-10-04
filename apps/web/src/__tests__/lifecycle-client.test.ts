import { describe, expect, it } from "vitest";
import {
  createPublicClient, custom, decodeFunctionData, encodeErrorResult, encodeFunctionResult, getAddress, zeroAddress,
  UserRejectedRequestError, type Address, type EIP1193Provider, type Hex,
} from "viem";
import { CampaignAbi } from "@cherrio/contracts/abis";
import { LifecycleError, sendLifecycle, toLifecycleFailure, type LifecycleAction } from "@/lib/campaigns/lifecycle-client";

// TASK-033b: simulate-then-send for every lifecycle action, against a fake
// EIP-1193 provider that answers like a Campaign clone.

const CAMPAIGN = getAddress("0x1234567890123456789012345678901234567890");
const DONOR = getAddress("0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7");

interface World { chainId?: number; revert?: string; state?: number; brokenReads?: boolean; rejectSend?: boolean }

function fake(world: World = {}) {
  const methods: string[] = [];
  const sent: { fn: string; args: readonly unknown[]; from: string }[] = [];
  const simulated: { fn: string; from: string }[] = [];
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      methods.push(method);
      if (world.brokenReads && method !== "eth_chainId" && method !== "eth_sendTransaction") throw new Error("Internal JSON-RPC error.");
      switch (method) {
        case "eth_chainId": return `0x${(world.chainId ?? 80002).toString(16)}`;
        case "eth_call": {
          const { data, from } = params![0] as { data: Hex; from?: string };
          const call = decodeFunctionData({ abi: CampaignAbi, data });
          if (call.functionName === "state") return encodeFunctionResult({ abi: CampaignAbi, functionName: "state", result: world.state ?? 5 });
          simulated.push({ fn: call.functionName, from: getAddress(from ?? zeroAddress) });
          if (world.revert) {
            const err = { code: 3, message: "execution reverted", data: encodeErrorResult({ abi: CampaignAbi, errorName: world.revert as never }) };
            throw Object.assign(new Error("execution reverted"), err);
          }
          return "0x";
        }
        case "eth_getBlockByNumber":
          return { number: "0x10", hash: `0x${"11".repeat(32)}`, parentHash: `0x${"22".repeat(32)}`, timestamp: "0x6a0f0000",
                   baseFeePerGas: "0x" + (40n * 10n ** 9n).toString(16), gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [],
                   uncles: [], nonce: "0x0000000000000000", difficulty: "0x0", logsBloom: "0x" + "00".repeat(256), miner: zeroAddress,
                   extraData: "0x", size: "0x1", stateRoot: `0x${"33".repeat(32)}`, receiptsRoot: `0x${"44".repeat(32)}`,
                   transactionsRoot: `0x${"55".repeat(32)}`, sha3Uncles: `0x${"66".repeat(32)}`, mixHash: `0x${"77".repeat(32)}` };
        case "eth_maxPriorityFeePerGas": return "0x" + 1_500_000_000n.toString(16);
        case "eth_sendTransaction": {
          if (world.rejectSend) throw new UserRejectedRequestError(new Error("User rejected the request."));
          const tx = params![0] as { data: Hex; from: string };
          const call = decodeFunctionData({ abi: CampaignAbi, data: tx.data });
          sent.push({ fn: call.functionName, args: call.args ?? [], from: getAddress(tx.from) });
          return `0x${"cd".repeat(32)}`;
        }
        default: throw new Error(`unexpected ${method}`);
      }
    },
  } as unknown as EIP1193Provider;
  return { provider, methods, sent, simulated };
}

const reader = (p: EIP1193Provider) => createPublicClient({ transport: custom(p) });
const call = (action: LifecycleAction) => ({ chainId: 80002, campaign: CAMPAIGN, action });

describe("sendLifecycle", () => {
  it("simulates from the donating address, then sends each action with its arguments", async () => {
    const cases: [LifecycleAction, string, readonly unknown[]][] = [
      [{ kind: "vote", approve: true }, "vote", [true]],
      [{ kind: "vote", approve: false }, "vote", [false]],
      [{ kind: "claimRefund" }, "claimRefund", []],
      [{ kind: "settleToPool", donor: DONOR }, "settleToPool", [DONOR]],
      [{ kind: "finalize" }, "finalize", []],
      [{ kind: "closeVote" }, "closeVote", []],
      [{ kind: "release" }, "release", []],
      [{ kind: "submitEvidence", bundleHash: `0x${"ab".repeat(32)}` }, "submitEvidence", [`0x${"ab".repeat(32)}`]],
    ];
    for (const [action, fn, args] of cases) {
      const w = fake();
      await sendLifecycle(w.provider, DONOR, call(action));
      expect(w.simulated, fn).toEqual([{ fn, from: DONOR }]);
      expect(w.sent, fn).toEqual([{ fn, args, from: DONOR }]);
    }
  });

  it("a refused simulation never reaches the wallet, and is named", async () => {
    const expectations: [string, string][] = [
      ["AlreadyVoted", "already_voted"], ["VoteEnded", "vote_ended"], ["VoteNotEnded", "not_due"], ["DeadlineNotReached", "not_due"],
      ["ReleaseDelayNotReached", "not_due"], ["NotDonor", "not_a_donor"], ["AlreadySettled", "already_settled"],
      ["InvalidPreference", "wrong_preference"], ["AlreadySwept", "swept"], ["PayoutModeNotSet", "payout_mode_not_set"],
      ["NotLive", "already_done"], ["NotVoting", "already_done"], ["NotFailedOrRejected", "already_done"], ["NotGuardian", "reverted"],
      ["NotBeneficiary", "not_beneficiary"], ["NotPaying", "already_done"],
    ];
    for (const [revert, code] of expectations) {
      const w = fake({ revert });
      const error = await sendLifecycle(w.provider, DONOR, call({ kind: "vote", approve: true })).catch((e: unknown) => e);
      expect(toLifecycleFailure(error), revert).toBe(code);
      expect(w.sent, revert).toEqual([]);
    }
  });

  it("a frozen campaign says so", async () => {
    const w = fake({ revert: "NotVoting", state: 8 });
    const error = await sendLifecycle(w.provider, DONOR, call({ kind: "vote", approve: true })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LifecycleError);
    expect(toLifecycleFailure(error)).toBe("frozen");
  });

  it("smart account: one sponsored batch with the same calldata, no wallet transaction", async () => {
    const w = fake();
    const batches: { to: Address; data: Hex }[][] = [];
    await sendLifecycle(w.provider, DONOR, call({ kind: "claimRefund" }), {
      sendCalls: async (calls) => { batches.push(calls); return `0x${"ef".repeat(32)}`; },
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((c) => [c.to, decodeFunctionData({ abi: CampaignAbi, data: c.data }).functionName])).toEqual([[CAMPAIGN, "claimRefund"]]);
    expect(w.sent).toEqual([]);
  });

  it("with a reader, the wallet answers only eth_chainId and eth_sendTransaction", async () => {
    const wallet = fake({ brokenReads: true });
    const healthy = fake();
    await sendLifecycle(wallet.provider, DONOR, call({ kind: "closeVote" }), { reader: reader(healthy.provider) });
    expect(wallet.sent.map((s) => s.fn)).toEqual(["closeVote"]);
    expect([...new Set(wallet.methods)].sort()).toEqual(["eth_chainId", "eth_sendTransaction"]);
    expect(healthy.simulated).toEqual([{ fn: "closeVote", from: DONOR }]);
  });

  it("wrong network and a rejection in the wallet", async () => {
    const w = fake({ chainId: 137 });
    expect(toLifecycleFailure(await sendLifecycle(w.provider, DONOR, call({ kind: "finalize" })).catch((e: unknown) => e))).toBe("wrong_network");
    expect(w.simulated).toEqual([]);
    const r = fake({ rejectSend: true });
    expect(toLifecycleFailure(await sendLifecycle(r.provider, DONOR, call({ kind: "finalize" })).catch((e: unknown) => e))).toBe("rejected");
    expect(toLifecycleFailure(new Error("AA21 didn't pay prefund"))).toBe("sponsorship_refused");
    expect(toLifecycleFailure(new Error("insufficient funds for gas * price + value"))).toBe("insufficient_gas");
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  decodeFunctionData, encodeErrorResult, getAddress, UserRejectedRequestError, zeroAddress, type EIP1193Provider, type Hex,
} from "viem";
import { EmergencyPoolAbi } from "@cherrio/contracts/abis";
import { getDb } from "@/lib/db";
import { voterStatus } from "@/lib/pool/public";
import { sendPoolVote, toPoolVoteFailure } from "@/lib/pool/vote-client";
import { GET as voterRoute } from "@/app/api/pool/allocations/[id]/voter/route";
import { ensureFakeChain } from "./helpers/fake-chain";

// TASK-014c-2: voting on an Emergency Pool allocation and counting it. The
// browser call is simulated through the wallet first (refusals named, nothing
// sent); the voter's weight follows EmergencyPool.voteAllocation.

const POOL = getAddress("0xFa7Fd0253813E196d74575A8F93ABB91cd009517");
const VOTER = getAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
const U = 1_000_000n;

function fake(world: { chainId?: number; revert?: string; rejectSend?: boolean } = {}) {
  const simulated: { fn: string; args: readonly unknown[] }[] = [];
  const sent: { fn: string; args: readonly unknown[] }[] = [];
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      switch (method) {
        case "eth_chainId": return `0x${(world.chainId ?? 80002).toString(16)}`;
        case "eth_call": {
          const { data } = params![0] as { data: Hex };
          const call = decodeFunctionData({ abi: EmergencyPoolAbi, data });
          simulated.push({ fn: call.functionName, args: call.args ?? [] });
          if (world.revert) {
            throw Object.assign(new Error("execution reverted"), { code: 3, message: "execution reverted", data: encodeErrorResult({ abi: EmergencyPoolAbi, errorName: world.revert as never }) });
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
        case "eth_estimateGas": return "0x5208";
        case "eth_sendTransaction": {
          if (world.rejectSend) throw new UserRejectedRequestError(new Error("User rejected the request."));
          const call = decodeFunctionData({ abi: EmergencyPoolAbi, data: (params![0] as { data: Hex }).data });
          sent.push({ fn: call.functionName, args: call.args ?? [] });
          return `0x${"cd".repeat(32)}`;
        }
        default: throw new Error(`unexpected ${method}`);
      }
    },
  } as unknown as EIP1193Provider;
  return { provider, simulated, sent };
}

const vote = (approve: boolean) => ({ chainId: 80002, pool: POOL, allocationId: 7n, action: { kind: "vote" as const, approve } });
const count = { chainId: 80002, pool: POOL, allocationId: 7n, action: { kind: "count" as const } };

describe("sendPoolVote (browser)", () => {
  it("simulates, then sends voteAllocation(id, approve) and closeAllocation(id)", async () => {
    const f = fake();
    await sendPoolVote(f.provider, VOTER, vote(false));
    await sendPoolVote(f.provider, VOTER, count);
    expect(f.simulated).toEqual([{ fn: "voteAllocation", args: [7n, false] }, { fn: "closeAllocation", args: [7n] }]);
    expect(f.sent).toEqual(f.simulated);
  });

  it("a smart account sends one sponsored call and signs nothing itself", async () => {
    const f = fake();
    const batches: Hex[][] = [];
    await sendPoolVote(f.provider, VOTER, vote(true), async (calls) => { batches.push(calls.map((c) => c.data)); return `0x${"ef".repeat(32)}`; });
    expect(f.sent).toEqual([]);
    expect(batches.map((b) => b.map((d) => decodeFunctionData({ abi: EmergencyPoolAbi, data: d }).args))).toEqual([[[7n, true]]]);
  });

  it("names every refusal before anything is signed; wrong network and a cancelled wallet too", async () => {
    for (const [revert, code] of [
      ["AllocationNotVoting", "not_voting"], ["VoteEnded", "vote_ended"], ["VoteNotEnded", "not_ended"],
      ["AlreadyVoted", "already_voted"], ["NoVotingWeight", "no_weight"],
    ] as const) {
      const f = fake({ revert });
      expect(toPoolVoteFailure(await sendPoolVote(f.provider, VOTER, vote(true)).catch((e: unknown) => e)), revert).toBe(code);
      expect(f.sent).toEqual([]);
    }
    expect(toPoolVoteFailure(await sendPoolVote(fake({ chainId: 1 }).provider, VOTER, count).catch((e: unknown) => e))).toBe("wrong_network");
    expect(toPoolVoteFailure(await sendPoolVote(fake({ rejectSend: true }).provider, VOTER, count).catch((e: unknown) => e))).toBe("rejected");
  });
});

describe("voter weight (Postgres, fake chain)", () => {
  const A = "0x93030000000000000000000000000000000000aa";
  const B = "0x93030000000000000000000000000000000000bb";
  const ID = 930301;
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("pool vote tests need DATABASE_URL");
    process.env.APP_ENV = "local";
    await ensureFakeChain(getDb());
    // A: 4 USDC at block 10 + 3 at block 20 (the proposal block) + 2 later; B: nothing before.
    await getDb().execute(sql`
      insert into chain.pool_contribution (id, pool_id, donor, amount, source, block_number) values
        ('t014v-1', 9303, ${A}, ${(4n * U).toString()}, 'DIRECT', 10),
        ('t014v-2', 9303, ${A}, ${(3n * U).toString()}, 'DIRECT', 20),
        ('t014v-3', 9303, ${A}, ${(2n * U).toString()}, 'DIRECT', 30),
        ('t014v-4', 9304, ${B}, ${(9n * U).toString()}, 'DIRECT', 5)`);
    await getDb().execute(sql`
      insert into chain.allocation (id, pool_id, campaign, amount, yes_votes, no_votes, vote_end, proposal_block, snap_quorum_bps, snap_approval_bps, state)
      values (${ID}, 9303, ${"0x9303000000000000000000000000000000000c01"}, ${U.toString()}, 0, 0, ${Math.floor(Date.now() / 1000) + 3600}, 20, 2500, 5100, 'VOTING')`);
  });
  afterAll(async () => {
    await getDb().execute(sql`delete from chain.allocation_vote where allocation_id = ${ID}`);
    await getDb().execute(sql`delete from chain.allocation where id = ${ID}`);
    await getDb().execute(sql`delete from chain.pool_contribution where id like 't014v-%'`);
  });

  it("weight = gifts to that sub-pool before the proposal block; another pool's gifts do not count; a vote is remembered", async () => {
    expect(await voterStatus(getDb(), BigInt(ID), A.toUpperCase().replace("0X", "0x"))).toEqual({ weight: 4n * U, voted: false });
    expect(await voterStatus(getDb(), BigInt(ID), B)).toEqual({ weight: 0n, voted: false });
    await getDb().execute(sql`insert into chain.allocation_vote (allocation_id, voter, approve, weight) values (${ID}, ${A}, true, ${(4n * U).toString()})`);
    expect(await voterStatus(getDb(), BigInt(ID), A)).toEqual({ weight: 4n * U, voted: true });
    expect(await voterStatus(getDb(), 999_999_999n, A)).toBeNull();
  });

  it("the public route validates its input and answers 404 for an unknown allocation", async () => {
    const get = async (id: string, address: string) => {
      const res = await voterRoute(new Request(`http://localhost/api/pool/allocations/${id}/voter?address=${address}`), { params: Promise.resolve({ id }) });
      return { status: res.status, body: (await res.json()) as unknown };
    };
    expect(await get(String(ID), A)).toEqual({ status: 200, body: { weight: String(4n * U), voted: true } });
    expect((await get("abc", A)).status).toBe(400);
    expect((await get(String(ID), "0x123")).status).toBe(400);
    expect((await get("999999999", A)).status).toBe(404);
  });
});

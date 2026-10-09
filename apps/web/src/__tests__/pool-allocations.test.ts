import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  createPublicClient, custom, decodeFunctionData, encodeErrorResult, getAddress, zeroAddress,
  type EIP1193Provider, type Hex,
} from "viem";
import * as schema from "@cherrio/db";
import { EmergencyPoolAbi } from "@cherrio/contracts/abis";
import { getDb } from "@/lib/db";
import { normalizeReason, proposableCampaigns, reasonHash, recordAllocationSent, saveAllocationReason } from "@/lib/pool/allocations";
import { sendProposeAllocation, toProposeFailure } from "@/lib/pool/allocation-client";
import { loadAllocations } from "@/lib/pool/public";
import { POST as reasonRoute } from "@/app/api/admin/emergency-pool/allocations/reason/route";
import { POST as sentRoute } from "@/app/api/admin/emergency-pool/allocations/sent/route";
import { cleanUp, createOrganization, createUser, ORIGIN, PAYOUT_ADDRESS, type TestUser } from "./helpers/organizations";
import { ensureFakeChain } from "./helpers/fake-chain";

// TASK-014c part 1: proposing an Emergency Pool allocation. The public reason is
// stored and its SHA-256 is the on-chain reasonHash; the Operator's call is
// simulated before the wallet signs; the public page shows the text that hashes
// to the chain's value.

const POOL = getAddress("0xFa7Fd0253813E196d74575A8F93ABB91cd009517");
const OPERATOR = getAddress("0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7");
const U = 1_000_000n;
const RUN = `t014c${Date.now().toString(36)}`;
const hex = (n: number) => `0x${randomBytes(n).toString("hex")}`;
const nowS = () => Math.floor(Date.now() / 1000);

function fake(world: { chainId?: number; revert?: string } = {}) {
  const simulated: { fn: string; args: readonly unknown[] }[] = [];
  const sent: { fn: string; args: readonly unknown[]; to: string }[] = [];
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      switch (method) {
        case "eth_chainId": return `0x${(world.chainId ?? 80002).toString(16)}`;
        case "eth_call": {
          const { data } = params![0] as { data: Hex };
          const call = decodeFunctionData({ abi: EmergencyPoolAbi, data });
          simulated.push({ fn: call.functionName, args: call.args ?? [] });
          if (world.revert) {
            const err = { code: 3, message: "execution reverted", data: encodeErrorResult({ abi: EmergencyPoolAbi, errorName: world.revert as never }) };
            throw Object.assign(new Error("execution reverted"), err);
          }
          return `0x${"00".repeat(32)}`;
        }
        case "eth_getBlockByNumber":
          return { number: "0x10", hash: `0x${"11".repeat(32)}`, parentHash: `0x${"22".repeat(32)}`, timestamp: "0x6a0f0000",
                   baseFeePerGas: "0x" + (40n * 10n ** 9n).toString(16), gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [],
                   uncles: [], nonce: "0x0000000000000000", difficulty: "0x0", logsBloom: "0x" + "00".repeat(256), miner: zeroAddress,
                   extraData: "0x", size: "0x1", stateRoot: `0x${"33".repeat(32)}`, receiptsRoot: `0x${"44".repeat(32)}`,
                   transactionsRoot: `0x${"55".repeat(32)}`, sha3Uncles: `0x${"66".repeat(32)}`, mixHash: `0x${"77".repeat(32)}` };
        case "eth_maxPriorityFeePerGas": return "0x" + 1_500_000_000n.toString(16);
        case "eth_sendTransaction": {
          const tx = params![0] as { data: Hex; to: string };
          const call = decodeFunctionData({ abi: EmergencyPoolAbi, data: tx.data });
          sent.push({ fn: call.functionName, args: call.args ?? [], to: getAddress(tx.to) });
          return `0x${"cd".repeat(32)}`;
        }
        default: throw new Error(`unexpected ${method}`);
      }
    },
  } as unknown as EIP1193Provider;
  return { provider, simulated, sent };
}
const reader = (p: EIP1193Provider) => createPublicClient({ transport: custom(p, { retryCount: 0 }) });

describe("sendProposeAllocation (browser)", () => {
  const campaign = getAddress("0x1111111111111111111111111111111111111111");
  const call = { chainId: 80002, pool: POOL, poolId: 2, campaign, amount: 250n * U, reasonHash: `0x${"ab".repeat(32)}` as Hex };

  it("simulates proposeAllocation(pool, campaign, amount, reasonHash), then sends it", async () => {
    const f = fake();
    expect(await sendProposeAllocation(f.provider, OPERATOR, call, { reader: reader(f.provider) })).toBe(`0x${"cd".repeat(32)}`);
    const expected = { fn: "proposeAllocation", args: [2, campaign, 250n * U, call.reasonHash] };
    expect(f.simulated).toEqual([expected]);
    expect(f.sent).toEqual([{ ...expected, to: POOL }]);
  });

  it("names every refusal of the contract and never reaches the wallet", async () => {
    for (const [revert, code] of [
      ["NotOperator", "not_operator"], ["PoolDoesNotExist", "pool_missing"], ["NotLiveCampaign", "campaign_not_live"],
      ["NotFactoryCampaign", "not_factory_campaign"], ["InsufficientPoolBalance", "insufficient_pool_balance"],
      ["CampaignDeadlineTooSoon", "deadline_too_soon"], ["PoolIdMismatch", "pool_mismatch"], ["AmountZero", "amount_zero"],
    ] as const) {
      const f = fake({ revert });
      const error = await sendProposeAllocation(f.provider, OPERATOR, call, { reader: reader(f.provider) }).catch((e: unknown) => e);
      expect(toProposeFailure(error), revert).toBe(code);
      expect(f.sent).toEqual([]);
    }
    const wrong = fake({ chainId: 137 });
    expect(toProposeFailure(await sendProposeAllocation(wrong.provider, OPERATOR, call).catch((e: unknown) => e))).toBe("wrong_network");
  });
});

describe("reasons", () => {
  it("reasonHash is SHA-256 of the exact UTF-8 text; the text is trimmed and line ends unified first", () => {
    const text = "Flood in Maribor — 3 shelters need food.";
    expect(reasonHash(text)).toBe(`0x${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`);
    expect(normalizeReason("  a\r\nb\r  ")).toBe("a\nb");
    expect(normalizeReason("   ")).toBeNull();
    expect(normalizeReason("x".repeat(1001))).toBeNull();
    expect(normalizeReason("x".repeat(1000))).toHaveLength(1000);
  });
});

describe("Admin → Emergency Pool → propose (Postgres, fake chain)", () => {
  let admin: TestUser;
  let member: TestUser;
  let orgId: string;
  let live: { id: string; address: string };
  let draftId: string;

  async function insertCampaign(status: "DEPLOYED" | "DRAFT", chain: { state: string; deadline: number } | null) {
    const address = chain ? hex(20) : null;
    const [row] = await getDb().insert(schema.campaigns).values({
      orgId, starterUserId: member.id, beneficiaryType: "ORGANIZATION", title: `Pool ${RUN} ${status}`, slug: `pool-${RUN}-${hex(3).slice(2)}`,
      story: { format: "plain", text: "Story. ".repeat(20) }, cause: "animals", country: "SI", goalAmountMinor: "1000000",
      durationDays: 30, status,
      ...(status === "DEPLOYED"
        ? { eurUsdRate: "1.17000000", rateSource: "ECB", rateAt: new Date(), targetUsdc: 1000n * U, beneficiaryAddress: PAYOUT_ADDRESS.toLowerCase(),
            deadline: new Date(chain!.deadline * 1000), onchainAddress: address }
        : {}),
    }).returning({ id: schema.campaigns.id });
    if (chain && address) {
      await getDb().execute(sql`
        insert into chain.campaign (address, offchain_id, beneficiary, beneficiary_type, target, deadline, state, tx_hash, log_index, block_number, block_time)
        values (${address}, ${hex(32)}, ${PAYOUT_ADDRESS.toLowerCase()}, 0, ${(1000n * U).toString()}, ${chain.deadline}, ${chain.state}, ${hex(32)}, 0, 1, ${nowS()})`);
    }
    return { id: row!.id, address: address ?? "" };
  }

  const post = async (route: typeof reasonRoute, path: string, user: TestUser | null, body: unknown) => {
    const headers: Record<string, string> = { "Content-Type": "application/json", Origin: ORIGIN };
    if (user) headers.cookie = user.cookie;
    const res = await route(new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: res.status, body: res.status === 404 ? null : ((await res.json()) as Record<string, unknown>) };
  };

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("pool allocation tests need DATABASE_URL");
    process.env.APP_ENV = "local";
    await ensureFakeChain(getDb());
    admin = await createUser({ admin: true });
    member = await createUser();
    orgId = (await createOrganization(member)).id;
    live = await insertCampaign("DEPLOYED", { state: "LIVE", deadline: nowS() + 30 * 86_400 });
    await insertCampaign("DEPLOYED", { state: "LIVE", deadline: nowS() - 60 }); // past its deadline: not offered
    await insertCampaign("DEPLOYED", { state: "FAILED", deadline: nowS() + 86_400 }); // not live: not offered
    draftId = (await insertCampaign("DRAFT", null)).id;
  });
  afterAll(async () => {
    await getDb().execute(sql`delete from chain.allocation where id = 930201`);
    await getDb().execute(sql`delete from chain.campaign where address in (select onchain_address from app.campaigns where title like ${`Pool ${RUN}%`})`);
    await cleanUp();
  });

  it("offers only published campaigns that are LIVE on chain and before their deadline", async () => {
    const list = (await proposableCampaigns(getDb()))!.filter((c) => c.title.startsWith(`Pool ${RUN}`));
    expect(list.map((c) => c.id)).toEqual([live.id]);
    expect(list[0]!.address).toBe(live.address);
  });

  it("stores the reason once per text and audits each save; a draft campaign or an empty reason is refused", async () => {
    const text = `  Flood relief ${RUN}\r\nfor the shelter.  `;
    const first = await saveAllocationReason(getDb(), admin.id, { poolId: 2, campaignId: live.id, amountUsdc: 250n * U, text });
    expect(first).toEqual({ ok: true, reasonHash: reasonHash(`Flood relief ${RUN}\nfor the shelter.`), campaignAddress: live.address });
    const again = await saveAllocationReason(getDb(), admin.id, { poolId: 2, campaignId: live.id, amountUsdc: 300n * U, text });
    expect(again).toEqual(first);
    const rows = await getDb().select().from(schema.poolAllocationReasons).where(eq(schema.poolAllocationReasons.campaignId, live.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: `Flood relief ${RUN}\nfor the shelter.`, poolId: 2, amountUsdc: String(250n * U), createdBy: admin.id });
    const audits = await getDb().select({ data: schema.auditLog.data }).from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "pool.allocation_reason_saved"), eq(schema.auditLog.entityId, live.id)));
    expect(audits.map((a) => (a.data as { reused: boolean }).reused).sort()).toEqual([false, true]);

    expect(await saveAllocationReason(getDb(), admin.id, { poolId: 2, campaignId: draftId, amountUsdc: U, text: "x" })).toEqual({ ok: false, error: "campaign_not_published" });
    expect(await saveAllocationReason(getDb(), admin.id, { poolId: 2, campaignId: live.id, amountUsdc: U, text: " \n " })).toEqual({ ok: false, error: "invalid_reason" });
  });

  it("routes: 404 for anyone but a platform admin; the admin gets the hash and records the sent transaction", async () => {
    const body = { poolId: 2, campaignId: live.id, amountUsdc: String(100n * U), reason: `Route reason ${RUN}` };
    expect((await post(reasonRoute, "/api/admin/emergency-pool/allocations/reason", null, body)).status).toBe(404);
    expect((await post(reasonRoute, "/api/admin/emergency-pool/allocations/reason", member, body)).status).toBe(404);
    expect((await post(reasonRoute, "/api/admin/emergency-pool/allocations/reason", admin, { ...body, amountUsdc: "0" })).status).toBe(400);
    const ok = await post(reasonRoute, "/api/admin/emergency-pool/allocations/reason", admin, body);
    expect(ok).toEqual({ status: 200, body: { reasonHash: reasonHash(`Route reason ${RUN}`), campaign: live.address } });

    const tx = `0x${"ce".repeat(32)}`;
    expect((await post(sentRoute, "/api/admin/emergency-pool/allocations/sent", member, { reasonHash: ok.body!.reasonHash, txHash: tx })).status).toBe(404);
    expect((await post(sentRoute, "/api/admin/emergency-pool/allocations/sent", admin, { reasonHash: `0x${"00".repeat(32)}`, txHash: tx })).status).toBe(404);
    expect((await post(sentRoute, "/api/admin/emergency-pool/allocations/sent", admin, { reasonHash: ok.body!.reasonHash, txHash: tx })).status).toBe(200);
    expect(await recordAllocationSent(getDb(), admin.id, { reasonHash: String(ok.body!.reasonHash).toUpperCase().replace("0X", "0x"), txHash: tx })).toBe(true);
    const sent = await getDb().select({ data: schema.auditLog.data }).from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "pool.allocation_propose.sent"), eq(schema.auditLog.entityId, live.id)));
    expect(sent).toHaveLength(2);
    expect(sent[0]!.data).toMatchObject({ poolId: 2, txHash: tx, reasonHash: ok.body!.reasonHash });
  });

  it("the public page shows the published reason for the allocation whose reasonHash matches", async () => {
    const text = `Flood relief ${RUN}\nfor the shelter.`;
    await getDb().execute(sql`
      insert into chain.allocation (id, pool_id, campaign, amount, delivered, reason_hash, yes_votes, no_votes, vote_end, proposal_block, snap_quorum_bps, snap_approval_bps, state)
      values (930201, 2, ${live.address}, ${(250n * U).toString()}, null, ${reasonHash(text)}, 0, 0, ${nowS() + 3600}, 50, 2500, 5100, 'VOTING')`);
    const row = (await loadAllocations(getDb()))!.find((a) => a.id === "930201")!;
    expect(row).toMatchObject({ reasonText: text, reasonHash: reasonHash(text), campaignTitle: `Pool ${RUN} DEPLOYED` });
    await getDb().execute(sql`update chain.allocation set reason_hash = ${`0x${"ab".repeat(32)}`} where id = 930201`);
    expect((await loadAllocations(getDb()))!.find((a) => a.id === "930201")!.reasonText).toBeNull();
  });
});

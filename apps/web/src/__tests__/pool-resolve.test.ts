import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  createPublicClient, custom, decodeFunctionData, encodeErrorResult, getAddress, zeroAddress,
  type EIP1193Provider, type Hex,
} from "viem";
import * as schema from "@cherrio/db";
import { EmergencyPoolAbi } from "@cherrio/contracts/abis";
import { getDb } from "@/lib/db";
import { sendResolveAllocation, toResolveFailure } from "@/lib/pool/allocation-client";
import { loadAllocations } from "@/lib/pool/public";
import { AllocationResolveRefusedError, recordResolveIntent, recordResolveSent } from "@/lib/pool/resolve";
import { POST as resolveRoute } from "@/app/api/admin/emergency-pool/allocations/[id]/resolve/route";
import { POST as sentRoute } from "@/app/api/admin/emergency-pool/allocations/[id]/resolve/sent/route";
import { cleanUp, createOrganization, createUser, ORIGIN, PAYOUT_ADDRESS, type TestUser } from "./helpers/organizations";
import { ensureFakeChain } from "./helpers/fake-chain";

// TASK-014c-3: the Guardian decides an Emergency Pool allocation that ended in
// NEEDS_REVIEW (resolveAllocation). The note is audited before the wallet opens,
// the call is simulated first, and the transaction is linked to the note.

const POOL = getAddress("0xFa7Fd0253813E196d74575A8F93ABB91cd009517");
const GUARDIAN = getAddress("0x5B38Da6a701c568545dCfcB03FcB875f56beddC4");
const U = 1_000_000n;
const RUN = `t014c3${Date.now().toString(36)}`;
const hex = (n: number) => `0x${randomBytes(n).toString("hex")}`;
const nowS = () => Math.floor(Date.now() / 1000);
const REVIEW_ID = 930301n;
const VOTING_ID = 930302n;

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
          const tx = params![0] as { data: Hex; to: string };
          const call = decodeFunctionData({ abi: EmergencyPoolAbi, data: tx.data });
          sent.push({ fn: call.functionName, args: call.args ?? [], to: getAddress(tx.to) });
          return `0x${"ef".repeat(32)}`;
        }
        default: throw new Error(`unexpected ${method}`);
      }
    },
  } as unknown as EIP1193Provider;
  return { provider, simulated, sent };
}
const reader = (p: EIP1193Provider) => createPublicClient({ transport: custom(p, { retryCount: 0 }) });

describe("sendResolveAllocation (browser)", () => {
  it("simulates resolveAllocation(id, approve) from the Guardian, then sends it to the pool", async () => {
    for (const approve of [true, false]) {
      const f = fake();
      const call = { chainId: 80002, pool: POOL, allocationId: 7n, approve };
      expect(await sendResolveAllocation(f.provider, GUARDIAN, call, { reader: reader(f.provider) })).toBe(`0x${"ef".repeat(32)}`);
      expect(f.simulated).toEqual([{ fn: "resolveAllocation", args: [7n, approve] }]);
      expect(f.sent).toEqual([{ fn: "resolveAllocation", args: [7n, approve], to: POOL }]);
    }
  });

  it("names the refusals (not the Guardian, already decided, wrong network) and never reaches the wallet", async () => {
    const call = { chainId: 80002, pool: POOL, allocationId: 7n, approve: true };
    for (const [revert, code] of [["NotGuardian", "not_guardian"], ["AllocationNotNeedsReview", "already_done"]] as const) {
      const f = fake({ revert });
      const error = await sendResolveAllocation(f.provider, GUARDIAN, call, { reader: reader(f.provider) }).catch((e: unknown) => e);
      expect(toResolveFailure(error), revert).toBe(code);
      expect(f.sent).toEqual([]);
    }
    const wrong = fake({ chainId: 137 });
    expect(toResolveFailure(await sendResolveAllocation(wrong.provider, GUARDIAN, call).catch((e: unknown) => e))).toBe("wrong_network");
    expect(wrong.simulated).toEqual([]);
  });
});

describe("Admin → Chain actions → pool allocations (Postgres, fake chain)", () => {
  let admin: TestUser;
  let member: TestUser;
  let campaignId: string;
  let address: string;

  const post = async (route: typeof resolveRoute, id: string, path: string, user: TestUser | null, body: unknown, origin = ORIGIN) => {
    const headers: Record<string, string> = { "Content-Type": "application/json", Origin: origin };
    if (user) headers.cookie = user.cookie;
    const res = await route(new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
    return { status: res.status, body: res.status === 404 ? null : ((await res.json()) as Record<string, unknown>) };
  };

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("pool resolve tests need DATABASE_URL");
    process.env.APP_ENV = "local";
    await ensureFakeChain(getDb());
    admin = await createUser({ admin: true });
    member = await createUser();
    const orgId = (await createOrganization(member)).id;
    address = hex(20);
    const [row] = await getDb().insert(schema.campaigns).values({
      orgId, starterUserId: member.id, beneficiaryType: "ORGANIZATION", title: `Resolve ${RUN}`, slug: `resolve-${RUN}`,
      story: { format: "plain", text: "Story. ".repeat(20) }, cause: "animals", country: "SI", goalAmountMinor: "1000000",
      durationDays: 30, status: "DEPLOYED", eurUsdRate: "1.17000000", rateSource: "ECB", rateAt: new Date(), targetUsdc: 1000n * U,
      beneficiaryAddress: PAYOUT_ADDRESS.toLowerCase(), deadline: new Date((nowS() + 30 * 86_400) * 1000), onchainAddress: address,
    }).returning({ id: schema.campaigns.id });
    campaignId = row!.id;
    for (const [id, state, yes] of [[REVIEW_ID, "NEEDS_REVIEW", 5n * U], [VOTING_ID, "VOTING", 0n]] as const) {
      await getDb().execute(sql`
        insert into chain.allocation (id, pool_id, campaign, amount, delivered, reason_hash, yes_votes, no_votes, vote_end, proposal_block, snap_quorum_bps, snap_approval_bps, state)
        values (${id.toString()}, 2, ${address}, ${(250n * U).toString()}, null, ${hex(32)}, ${yes.toString()}, 0, ${nowS() - 60}, 50, 2500, 5100, ${state})`);
    }
  });
  afterAll(async () => {
    await getDb().execute(sql`delete from chain.allocation where id in (${REVIEW_ID.toString()}, ${VOTING_ID.toString()})`);
    await cleanUp();
  });

  it("loadAllocations narrows to NEEDS_REVIEW for the Guardian's list", async () => {
    const ids = (await loadAllocations(getDb(), 100, { state: "NEEDS_REVIEW" }))!.map((a) => a.id);
    expect(ids).toContain(REVIEW_ID.toString());
    expect(ids).not.toContain(VOTING_ID.toString());
    const row = (await loadAllocations(getDb(), 100, { state: "NEEDS_REVIEW" }))!.find((a) => a.id === REVIEW_ID.toString())!;
    expect(row).toMatchObject({ state: "NEEDS_REVIEW", campaignTitle: `Resolve ${RUN}`, amount: 250n * U, yes: 5n * U });
  });

  it("audits the decision before the wallet opens; refuses an allocation that is not NEEDS_REVIEW or unknown", async () => {
    const note = `Low turnout, campaign verified ${RUN}`;
    const { requestId } = await recordResolveIntent(getDb(), admin.id, REVIEW_ID, { approve: true, note });
    const [entry] = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.id, requestId));
    expect(entry).toMatchObject({ actorUserId: admin.id, action: "pool.allocation_resolve.requested", entityType: "campaign", entityId: campaignId });
    expect(entry!.data).toEqual({ allocationId: REVIEW_ID.toString(), approve: true, note, poolId: 2, campaign: address, amountUsdc: (250n * U).toString() });

    await expect(recordResolveIntent(getDb(), admin.id, VOTING_ID, { approve: true, note })).rejects.toMatchObject({ code: "wrong_state" });
    await expect(recordResolveIntent(getDb(), admin.id, 999999991n, { approve: false, note })).rejects.toBeInstanceOf(AllocationResolveRefusedError);

    const tx = `0x${"AB".repeat(32)}`;
    await recordResolveSent(getDb(), admin.id, REVIEW_ID, { requestId, txHash: tx });
    const sent = await getDb().select({ data: schema.auditLog.data }).from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "pool.allocation_resolve.sent"), eq(schema.auditLog.entityId, campaignId)));
    expect(sent.map((s) => s.data)).toEqual([{ requestId, allocationId: REVIEW_ID.toString(), approve: true, txHash: tx.toLowerCase() }]);
    // A request of another allocation cannot be linked here.
    await expect(recordResolveSent(getDb(), admin.id, VOTING_ID, { requestId, txHash: tx })).rejects.toMatchObject({ code: "not_found" });
  });

  it("routes: 404 for anyone but a platform admin, 403 from another origin, 400 without a real note, 409 when not NEEDS_REVIEW", async () => {
    const path = (id: bigint | string) => `/api/admin/emergency-pool/allocations/${id}/resolve`;
    const body = { approve: false, note: `Returning to the pool ${RUN}` };
    const id = REVIEW_ID.toString();
    expect((await post(resolveRoute, id, path(id), null, body)).status).toBe(404);
    expect((await post(resolveRoute, id, path(id), member, body)).status).toBe(404);
    expect((await post(resolveRoute, "abc", path("abc"), admin, body)).status).toBe(404);
    expect((await post(resolveRoute, id, path(id), admin, body, "https://evil.example")).status).toBe(403);
    expect((await post(resolveRoute, id, path(id), admin, { approve: false, note: "short" })).status).toBe(400);
    expect(await post(resolveRoute, VOTING_ID.toString(), path(VOTING_ID), admin, body)).toEqual({ status: 409, body: { error: "wrong_state" } });
    expect((await post(resolveRoute, "999999992", path("999999992"), admin, body)).status).toBe(404);

    const ok = await post(resolveRoute, id, path(id), admin, body);
    expect(ok.status).toBe(200);
    const requestId = String(ok.body!.requestId);
    const tx = `0x${"cd".repeat(32)}`;
    expect((await post(sentRoute, id, `${path(id)}/sent`, member, { requestId, txHash: tx })).status).toBe(404);
    expect((await post(sentRoute, id, `${path(id)}/sent`, admin, { requestId, txHash: "0x12" })).status).toBe(400);
    expect((await post(sentRoute, VOTING_ID.toString(), `${path(VOTING_ID)}/sent`, admin, { requestId, txHash: tx })).status).toBe(404);
    expect(await post(sentRoute, id, `${path(id)}/sent`, admin, { requestId, txHash: tx })).toEqual({ status: 200, body: { ok: true } });
  });
});

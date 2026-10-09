import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like, sql } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { getDb } from "@/lib/db";
import {
  dueFallbacks, FALLBACK_IDLE_SECONDS, listChainActionLog, loadGuardianQueue, loadPayoutSuggestion, openChainActions, suggestPayoutMode,
} from "@/lib/admin/guardian";
import type { CampaignLifecycle, ChainState } from "@/lib/campaigns/lifecycle";
import { POST as intentRoute } from "@/app/api/admin/campaigns/[id]/chain-actions/route";
import { POST as sentRoute } from "@/app/api/admin/campaigns/[id]/chain-actions/sent/route";
import { cleanUp, createOrganization, createUser, ORIGIN, PAYOUT_ADDRESS, type TestUser } from "./helpers/organizations";
import { deleteFakeChainRows, ensureFakeChain } from "./helpers/fake-chain";

// TASK-033d: admin chain actions — which action is open, the payout
// suggestion, the queue, and the audited intent → sent API.
// TASK-033f: the manual fallbacks (finalize / closeVote 7 days late,
// sweepUnclaimed after the refund window), with the exact boundaries.

const { auditLog, campaigns, ratings } = schema;
const RUN = Date.now().toString(36);
const U = 1_000_000n;
const now = () => Math.floor(Date.now() / 1000);
const addr = () => `0x${randomBytes(20).toString("hex")}`;
const hash = () => `0x${randomBytes(32).toString("hex")}`;

const T0 = 1_800_000_000n;
const DAY = 86_400n;
const SWEEP = 180n * DAY;
type Fields = Parameters<typeof openChainActions>[0];
function lcOf(state: ChainState, over: Partial<Fields> = {}): Fields {
  const snapshot: CampaignLifecycle["snapshot"] = {
    voteWindow: 3600, quorumBps: 2500, approvalBps: 5100, releaseDelay: 259_200, refundSweepDelay: Number(SWEEP),
  };
  return { state, payoutMode: null, deadline: T0, voteEnd: T0, settlementStart: T0, swept: false, snapshot, ...over };
}

describe("openChainActions (mirrors Campaign.sol)", () => {
  it("payout mode only once after success; resolve on review/frozen; freeze on the five live states", () => {
    const states: ChainState[] = ["LIVE", "SUCCEEDED", "FAILED", "PAYING", "COMPLETED", "VOTING", "NEEDS_REVIEW", "REJECTED", "FROZEN"];
    const table = Object.fromEntries(states.map((state) => [state, openChainActions(lcOf(state), T0)]));
    expect(states.filter((s) => table[s]!.setPayoutMode)).toEqual(["SUCCEEDED"]);
    expect(states.filter((s) => table[s]!.resolve)).toEqual(["NEEDS_REVIEW", "FROZEN"]);
    expect(states.filter((s) => table[s]!.freeze)).toEqual(["LIVE", "SUCCEEDED", "PAYING", "VOTING", "NEEDS_REVIEW"]);
    expect(openChainActions(lcOf("SUCCEEDED", { payoutMode: 1 }), T0).setPayoutMode).toBe(false);
    // At the deadline itself no fallback is due yet.
    expect(states.filter((s) => table[s]!.finalize || table[s]!.closeVote || table[s]!.sweepUnclaimed)).toEqual([]);
  });
});

describe("dueFallbacks (TASK-033f, ADR-050)", () => {
  it("finalize: LIVE, exactly 7 days after the deadline — not one second earlier", () => {
    expect(FALLBACK_IDLE_SECONDS).toBe(7n * DAY);
    expect(dueFallbacks(lcOf("LIVE"), T0 + 7n * DAY - 1n).finalize).toBe(false);
    expect(dueFallbacks(lcOf("LIVE"), T0 + 7n * DAY).finalize).toBe(true);
    expect(dueFallbacks(lcOf("SUCCEEDED"), T0 + 30n * DAY).finalize).toBe(false);
  });

  it("closeVote: VOTING, exactly 7 days after the vote end", () => {
    expect(dueFallbacks(lcOf("VOTING"), T0 + 7n * DAY - 1n).closeVote).toBe(false);
    expect(dueFallbacks(lcOf("VOTING"), T0 + 7n * DAY).closeVote).toBe(true);
    expect(dueFallbacks(lcOf("NEEDS_REVIEW"), T0 + 30n * DAY).closeVote).toBe(false);
  });

  it("sweepUnclaimed: FAILED/REJECTED, not swept, after the campaign's own refund window; unknown window → never", () => {
    for (const state of ["FAILED", "REJECTED"] as const) {
      expect(dueFallbacks(lcOf(state), T0 + SWEEP - 1n).sweepUnclaimed).toBe(false);
      expect(dueFallbacks(lcOf(state), T0 + SWEEP).sweepUnclaimed).toBe(true);
    }
    expect(dueFallbacks(lcOf("FAILED", { swept: true }), T0 + SWEEP).sweepUnclaimed).toBe(false);
    const unknown = lcOf("FAILED");
    unknown.snapshot = { ...unknown.snapshot, refundSweepDelay: null };
    expect(dueFallbacks(unknown, T0 + 10n * SWEEP).sweepUnclaimed).toBe(false);
    expect(dueFallbacks(lcOf("COMPLETED"), T0 + 10n * SWEEP).sweepUnclaimed).toBe(false);
  });
});

describe("suggestPayoutMode (Product Spec §2.4)", () => {
  it("individual → milestones; first campaign → single; then by rating, careful without one", () => {
    expect(suggestPayoutMode({ individual: true, earlierCampaigns: 0, rating: 5 })).toMatchObject({ mode: 1, reason: "individual" });
    expect(suggestPayoutMode({ individual: false, earlierCampaigns: 0, rating: null })).toMatchObject({ mode: 0, reason: "first_campaign" });
    expect(suggestPayoutMode({ individual: false, earlierCampaigns: 2, rating: 4 })).toMatchObject({ mode: 0, reason: "rating_high" });
    expect(suggestPayoutMode({ individual: false, earlierCampaigns: 2, rating: 3.9 })).toMatchObject({ mode: 1, reason: "rating_low" });
    expect(suggestPayoutMode({ individual: false, earlierCampaigns: 1, rating: null })).toMatchObject({ mode: 1, reason: "no_rating" });
  });
});

let owner: TestUser;
let admin: TestUser;
let rater: TestUser;
let orgId: string;
const chainAddresses: string[] = [];
let n = 0;

async function deployed(chain: Record<string, string | number | boolean | null>, deployedAt = new Date()) {
  const address = addr();
  const [row] = await getDb().insert(campaigns).values({
    orgId, starterUserId: owner.id, beneficiaryType: "ORGANIZATION", title: `Guardian ${RUN} ${++n}`, slug: `guardian-${RUN}-${n}`,
    story: { format: "plain", text: "Story. ".repeat(20) }, cause: "animals", country: "SI", goalAmountMinor: "1000000",
    durationDays: 30, status: "DEPLOYED", eurUsdRate: "1.17000000", rateSource: "ECB", rateAt: new Date(),
    targetUsdc: 1000n * U, beneficiaryAddress: PAYOUT_ADDRESS.toLowerCase(), deadline: new Date(), onchainAddress: address, deployedAt,
  }).returning({ id: campaigns.id });
  chainAddresses.push(address);
  const cols = { state: "LIVE", total_raised: (500n * U).toString(), deadline: now() - 10, ...chain };
  const names = Object.keys(cols);
  await getDb().execute(sql`
    insert into chain.campaign (address, offchain_id, beneficiary, beneficiary_type, target, tx_hash, log_index, block_number, block_time,
      ${sql.raw(names.join(", "))})
    values (${address}, ${hash()}, ${PAYOUT_ADDRESS.toLowerCase()}, 0, ${(1000n * U).toString()}, ${hash()}, 0, 1, ${now()},
      ${sql.join(names.map((k) => sql`${cols[k as keyof typeof cols]}`), sql`, `)})
  `);
  return { id: row!.id, address };
}

async function post(route: typeof intentRoute, user: TestUser | null, id: string, body: unknown, origin = ORIGIN) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: origin };
  if (user) headers.cookie = user.cookie;
  const res = await route(new Request(`${ORIGIN}/api/admin/campaigns/${id}/chain-actions`, { method: "POST", headers, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });
  return { status: res.status, body: res.status === 404 ? null : ((await res.json()) as Record<string, unknown>) };
}

describe("admin chain actions (Postgres, fake chain)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("guardian tests need DATABASE_URL");
    process.env.APP_ENV = "local";
    await ensureFakeChain(getDb());
    owner = await createUser();
    rater = await createUser();
    admin = await createUser({ admin: true });
    orgId = (await createOrganization(owner)).id;
  });

  afterAll(async () => {
    const db = getDb();
    for (const a of chainAddresses) await deleteFakeChainRows(db, a);
    await db.delete(ratings).where(eq(ratings.orgId, orgId));
    await cleanUp();
  });

  it("the queue lists exactly the campaigns waiting for an admin, with their task", async () => {
    const payout = await deployed({ state: "SUCCEEDED", payout_mode: null, end_time: now() - 100 });
    const review = await deployed({ state: "NEEDS_REVIEW", payout_mode: 1, end_time: now() - 90 });
    const frozen = await deployed({ state: "FROZEN", prev_state: "PAYING", payout_mode: 1, end_time: now() - 80 });
    const modeSet = await deployed({ state: "SUCCEEDED", payout_mode: 0 });
    const live = await deployed({ state: "LIVE" });
    const queue = (await loadGuardianQueue(getDb()))!;
    const mine = queue.filter((r) => [payout, review, frozen, modeSet, live].some((c) => c.id === r.id));
    expect(mine.map((r) => [r.id, r.task])).toEqual([[payout.id, "payout_mode"], [review.id, "review"], [frozen.id, "frozen"]]);
    expect(mine[0]!.organization).toBeTruthy();
  });

  it("the queue lists the due fallbacks only once they are due (TASK-033f)", async () => {
    const t = BigInt(now());
    const late = await deployed({ state: "LIVE", deadline: Number(t - 7n * DAY - 5n) });
    const early = await deployed({ state: "LIVE", deadline: Number(t - 7n * DAY + 3600n) });
    const vote = await deployed({ state: "VOTING", vote_end: Number(t - 8n * DAY) });
    const voteOpen = await deployed({ state: "VOTING", vote_end: Number(t - DAY) });
    const sweep = await deployed({ state: "FAILED", settlement_start: Number(t - SWEEP - 10n), snap_refund_sweep_delay: Number(SWEEP) });
    const swept = await deployed({ state: "REJECTED", settlement_start: Number(t - SWEEP - 10n), snap_refund_sweep_delay: Number(SWEEP), swept: true });
    const notYet = await deployed({ state: "REJECTED", settlement_start: Number(t - DAY), snap_refund_sweep_delay: Number(SWEEP) });
    const all = [late, early, vote, voteOpen, sweep, swept, notYet];
    const queue = (await loadGuardianQueue(getDb(), t))!;
    const mine = queue.filter((r) => all.some((c) => c.id === r.id));
    // Oldest task first: the sweep has been due for 10 s, the vote for a day, the finalize for 5 s.
    expect(mine.map((r) => [r.id, r.task])).toEqual([
      [vote.id, "close_vote_overdue"], [sweep.id, "sweep_due"], [late.id, "finalize_overdue"],
    ]);
    // An hour later the second LIVE campaign is due too.
    const later = (await loadGuardianQueue(getDb(), t + 3601n))!.filter((r) => all.some((c) => c.id === r.id));
    expect(later.map((r) => r.id)).toContain(early.id);
  });

  it("a fallback intent is accepted once due, without a note, and refused before", async () => {
    const t = now();
    const due = await deployed({ state: "LIVE", deadline: t - 7 * 86_400 - 5 });
    const early = await deployed({ state: "LIVE", deadline: t - 60 });
    expect(await post(intentRoute, admin, early.id, { action: "finalize" })).toEqual({ status: 409, body: { error: "wrong_state" } });
    const intent = await post(intentRoute, admin, due.id, { action: "finalize" });
    expect(intent.status).toBe(200);
    expect(await post(intentRoute, admin, due.id, { action: "closeVote" })).toEqual({ status: 409, body: { error: "wrong_state" } });
    expect(await post(intentRoute, admin, due.id, { action: "finalize", note: "short" })).toEqual({ status: 400, body: { error: "validation_failed" } });
    const tx = hash();
    await post(sentRoute, admin, due.id, { requestId: intent.body!.requestId, txHash: tx });
    const log = await listChainActionLog(getDb(), due.id);
    expect(log.map((e) => [e.action, e.phase, e.txHash])).toEqual([["finalize", "sent", tx], ["finalize", "requested", null]]);

    const sweep = await deployed({ state: "FAILED", settlement_start: t - 200 * 86_400, snap_refund_sweep_delay: 180 * 86_400 });
    expect(await post(intentRoute, admin, sweep.id, { action: "sweepUnclaimed", note: "Refund window over, no claims." })).toMatchObject({ status: 200 });
  });

  it("payout suggestion: the organisation's first campaign → single; a later one follows the rating", async () => {
    const first = await deployed({ state: "SUCCEEDED" }, new Date(Date.now() - 86_400_000 * 400));
    const firstSuggestion = await loadPayoutSuggestion(getDb(), first.id);
    // Earlier tests in this file deployed later campaigns; the oldest one is "first".
    expect(firstSuggestion).toMatchObject({ mode: 0, reason: "first_campaign" });
    const later = await deployed({ state: "SUCCEEDED" });
    expect(await loadPayoutSuggestion(getDb(), later.id)).toMatchObject({ mode: 1, reason: "no_rating", rating: null });
    await getDb().insert(ratings).values([
      { orgId, campaignId: first.id, userId: rater.id, stars: 5 },
      { orgId, campaignId: later.id, userId: rater.id, stars: 4 },
    ]);
    expect(await loadPayoutSuggestion(getDb(), later.id)).toMatchObject({ mode: 0, reason: "rating_high", rating: 4.5 });
  });

  it("intent → wallet → sent: note and transaction land in audit_log and in the campaign's log", async () => {
    const c = await deployed({ state: "NEEDS_REVIEW", payout_mode: 1, current_round: 1 });
    const intent = await post(intentRoute, admin, c.id, { action: "resolve", approve: false, note: "Invoices do not match the plan." });
    expect(intent.status).toBe(200);
    const requestId = intent.body!.requestId as string;
    const [row] = await getDb().select().from(auditLog).where(eq(auditLog.id, requestId));
    expect(row).toMatchObject({ action: "chain.resolve.requested", entityType: "campaign", entityId: c.id, actorUserId: admin.id });
    expect(row!.data).toMatchObject({ approve: false, note: "Invoices do not match the plan.", state: "NEEDS_REVIEW", round: 1, campaign: c.address });

    const tx = hash();
    const sent = await post(sentRoute, admin, c.id, { requestId, txHash: tx.toUpperCase().replace("0X", "0x") });
    expect(sent).toEqual({ status: 200, body: { ok: true } });
    const log = await listChainActionLog(getDb(), c.id);
    expect(log.map((e) => [e.action, e.phase, e.approve, e.note, e.txHash])).toEqual([
      ["resolve", "sent", null, null, tx],
      ["resolve", "requested", false, "Invoices do not match the plan.", null],
    ]);
    expect(log[0]!.requestId).toBe(requestId);
    expect(log[0]!.actor).toBeTruthy();
  });

  it("refuses an action the indexed state does not allow, a missing note, and SINGLE for an individual", async () => {
    const live = await deployed({ state: "LIVE" });
    expect(await post(intentRoute, admin, live.id, { action: "resolve", approve: true, note: "Looks fine to me, approve." })).toEqual({
      status: 409, body: { error: "wrong_state" },
    });
    expect(await post(intentRoute, admin, live.id, { action: "setPayoutMode", mode: 1 })).toEqual({ status: 409, body: { error: "wrong_state" } });
    expect(await post(intentRoute, admin, live.id, { action: "freeze", note: "short" })).toEqual({ status: 400, body: { error: "validation_failed" } });
    expect(await post(intentRoute, admin, live.id, { action: "freeze", note: "Reported as a scam by the bank." })).toMatchObject({ status: 200 });

    const succeeded = await deployed({ state: "SUCCEEDED", payout_mode: null });
    expect(await post(intentRoute, admin, succeeded.id, { action: "setPayoutMode", mode: 0 })).toMatchObject({ status: 200 });
    await getDb().update(campaigns).set({ beneficiaryType: "INDIVIDUAL" }).where(eq(campaigns.id, succeeded.id));
    expect(await post(intentRoute, admin, succeeded.id, { action: "setPayoutMode", mode: 0 })).toEqual({ status: 409, body: { error: "wrong_state" } });
    expect(await post(intentRoute, admin, succeeded.id, { action: "setPayoutMode", mode: 1, note: "" })).toMatchObject({ status: 200 });

    const unknown = await post(sentRoute, admin, live.id, { requestId: crypto.randomUUID(), txHash: hash() });
    expect(unknown.status).toBe(404);
  });

  it("a campaign without a contract, and the indexer's view missing for the campaign", async () => {
    const c = await deployed({ state: "SUCCEEDED" });
    await getDb().execute(sql`delete from chain.campaign where address = ${c.address}`);
    expect(await post(intentRoute, admin, c.id, { action: "setPayoutMode", mode: 1 })).toEqual({ status: 503, body: { error: "chain_unavailable" } });
    await getDb().update(campaigns).set({ status: "APPROVED", onchainAddress: null }).where(eq(campaigns.id, c.id));
    expect(await post(intentRoute, admin, c.id, { action: "setPayoutMode", mode: 1 })).toEqual({ status: 409, body: { error: "not_deployed" } });
  });

  it("everyone but a platform admin gets 404; the origin is checked", async () => {
    const c = await deployed({ state: "NEEDS_REVIEW" });
    const body = { action: "freeze", note: "Reported as a scam by the bank." };
    expect((await post(intentRoute, null, c.id, body)).status).toBe(404);
    expect((await post(intentRoute, owner, c.id, body)).status).toBe(404);
    expect((await post(sentRoute, owner, c.id, { requestId: crypto.randomUUID(), txHash: hash() })).status).toBe(404);
    expect(await post(intentRoute, admin, c.id, body, "https://evil.example")).toEqual({ status: 403, body: { error: "forbidden" } });
    const rows = await getDb().select().from(auditLog).where(and(eq(auditLog.entityId, c.id), like(auditLog.action, "chain.%")));
    expect(rows).toEqual([]);
  });
});

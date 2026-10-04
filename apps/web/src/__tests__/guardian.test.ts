import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like, sql } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { getDb } from "@/lib/db";
import {
  listChainActionLog, loadGuardianQueue, loadPayoutSuggestion, openChainActions, suggestPayoutMode,
} from "@/lib/admin/guardian";
import type { ChainState } from "@/lib/campaigns/lifecycle";
import { POST as intentRoute } from "@/app/api/admin/campaigns/[id]/chain-actions/route";
import { POST as sentRoute } from "@/app/api/admin/campaigns/[id]/chain-actions/sent/route";
import { cleanUp, createOrganization, createUser, ORIGIN, PAYOUT_ADDRESS, type TestUser } from "./helpers/organizations";
import { deleteFakeChainRows, ensureFakeChain } from "./helpers/fake-chain";

// TASK-033d: admin chain actions — which action is open, the payout
// suggestion, the queue, and the audited intent → sent API.

const { auditLog, campaigns, ratings } = schema;
const RUN = Date.now().toString(36);
const U = 1_000_000n;
const now = () => Math.floor(Date.now() / 1000);
const addr = () => `0x${randomBytes(20).toString("hex")}`;
const hash = () => `0x${randomBytes(32).toString("hex")}`;

describe("openChainActions (mirrors Campaign.sol)", () => {
  it("payout mode only once after success; resolve on review/frozen; freeze on the five live states", () => {
    const states: ChainState[] = ["LIVE", "SUCCEEDED", "FAILED", "PAYING", "COMPLETED", "VOTING", "NEEDS_REVIEW", "REJECTED", "FROZEN"];
    const table = Object.fromEntries(states.map((state) => [state, openChainActions({ state, payoutMode: null })]));
    expect(states.filter((s) => table[s]!.setPayoutMode)).toEqual(["SUCCEEDED"]);
    expect(states.filter((s) => table[s]!.resolve)).toEqual(["NEEDS_REVIEW", "FROZEN"]);
    expect(states.filter((s) => table[s]!.freeze)).toEqual(["LIVE", "SUCCEEDED", "PAYING", "VOTING", "NEEDS_REVIEW"]);
    expect(openChainActions({ state: "SUCCEEDED", payoutMode: 1 }).setPayoutMode).toBe(false);
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

async function deployed(chain: Record<string, string | number | null>, deployedAt = new Date()) {
  const address = addr();
  const [row] = await getDb().insert(campaigns).values({
    orgId, starterUserId: owner.id, beneficiaryType: "ORGANIZATION", title: `Guardian ${RUN} ${++n}`, slug: `guardian-${RUN}-${n}`,
    story: { format: "plain", text: "Story. ".repeat(20) }, cause: "animals", country: "SI", targetEurCents: "1000000",
    durationDays: 30, status: "DEPLOYED", eurUsdRate: "1.17000000", rateSource: "ECB", rateAt: new Date(),
    targetUsdc: 1000n * U, beneficiaryAddress: PAYOUT_ADDRESS.toLowerCase(), deadline: new Date(), onchainAddress: address, deployedAt,
  }).returning({ id: campaigns.id });
  chainAddresses.push(address);
  const cols = { state: "LIVE", total_raised: (500n * U).toString(), ...chain };
  const names = Object.keys(cols);
  await getDb().execute(sql`
    insert into chain.campaign (address, offchain_id, beneficiary, beneficiary_type, target, deadline, tx_hash, log_index, block_number, block_time,
      ${sql.raw(names.join(", "))})
    values (${address}, ${hash()}, ${PAYOUT_ADDRESS.toLowerCase()}, 0, ${(1000n * U).toString()}, ${now() - 10}, ${hash()}, 0, 1, ${now()},
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

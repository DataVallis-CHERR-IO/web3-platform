import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { awardPoints, FULL_SWEEP_MS, newPointsCursor, OVERLAP_BLOCKS } from "../src/points.js";
import { enqueueLifecycle } from "../src/notify/enqueue.js";
import { MAX_ATTEMPTS, sendPending, type Mailer, type OutgoingEmail } from "../src/notify/send.js";
import { renderEmail } from "../src/notify/templates.js";
import { ensureFakeChain, deleteFakeChainRows } from "../../web/src/__tests__/helpers/fake-chain.js";

// TASK-033e (ADR-048): points, email queue and sender against Postgres with
// the fake chain.* tables the web tests use (no indexer here).

const url = process.env.DATABASE_URL;
if (!url) throw new Error("worker tests need DATABASE_URL");
const db = schema.createDb(url, { max: 2 });
const { users, userAddresses, campaigns, notifications, notificationPreferences, pointsLedger, userLevels } = schema;

const RUN = Date.now().toString(36);
const NOW = BigInt(Math.floor(Date.now() / 1000));
const BASE = "https://dev.cherr.io";
const addr = () => `0x${randomBytes(20).toString("hex")}`;
const hex32 = () => `0x${randomBytes(32).toString("hex")}`;
const userIds: string[] = [];
const chainAddresses: string[] = [];
let starter: string;
let n = 0;

async function user(
  opts: { email?: string | null; prefs?: { emailEnabled?: boolean; contactEmail?: string }; privy?: boolean; referredBy?: string } = {}
) {
  const [u] = await db
    .insert(users)
    .values({
      displayName: `Worker ${RUN} ${++n}`, email: opts.email ?? null,
      privyDid: opts.privy ? `privy|worker-${RUN}-${n}` : null, referredByUserId: opts.referredBy ?? null,
    })
    .returning({ id: users.id });
  userIds.push(u!.id);
  if (opts.prefs) {
    await db.insert(notificationPreferences).values({ userId: u!.id, unsubscribeToken: `tok-${RUN}-${n}`, ...opts.prefs });
  }
  return u!.id;
}

async function link(userId: string) {
  const a = addr();
  await db.insert(userAddresses).values({ userId, address: a, kind: "EXTERNAL" });
  return a;
}

async function campaign(chain: Record<string, string | number | boolean>, title = `Roof ${RUN} ${++n}`) {
  const address = addr();
  chainAddresses.push(address);
  await db.insert(campaigns).values({
    starterUserId: starter, beneficiaryType: "INDIVIDUAL", title, slug: `worker-${RUN}-${n}`,
    story: { format: "plain", text: "Story. ".repeat(20) }, cause: "animals", country: "SI", targetEurCents: "1000000",
    durationDays: 30, status: "DEPLOYED", eurUsdRate: "1.17000000", rateSource: "ECB", rateAt: new Date(),
    targetUsdc: 1_000_000_000n, beneficiaryAddress: addr(), deadline: new Date(), onchainAddress: address,
  });
  const cols = { state: "PAYING", ...chain };
  const names = Object.keys(cols);
  await db.execute(sql`
    insert into chain.campaign (address, offchain_id, beneficiary, beneficiary_type, target, deadline, tx_hash, log_index, block_number, block_time,
      ${sql.raw(names.join(", "))})
    values (${address}, ${hex32()}, ${addr()}, 1, 1000000000, ${NOW.toString()}, ${hex32()}, 0, 1, ${NOW.toString()},
      ${sql.join(names.map((k) => sql`${cols[k as keyof typeof cols]}`), sql`, `)})
  `);
  return address;
}

async function donor(campaignAddress: string, who: string, preference = 0, settled = false) {
  await db.execute(sql`
    insert into chain.campaign_donor (campaign, donor, donated, preference, sub_pool_id, settled)
    values (${campaignAddress}, ${who}, 100000000, ${preference}, 0, ${settled})
  `);
}

async function round(c: string, r: number, opts: { opened: bigint; voteEnd: bigint; outcome?: string; closedAt?: bigint }) {
  await db.execute(sql`
    insert into chain.vote_round (campaign, round, bundle_hash, vote_end, yes_votes, no_votes, outcome, closed_at, tx_hash, log_index, block_number, block_time)
    values (${c}, ${r}, ${hex32()}, ${opts.voteEnd.toString()}, 0, 0, ${opts.outcome ?? null}, ${opts.closedAt?.toString() ?? null}, ${hex32()}, 0, 1, ${opts.opened.toString()})
  `);
}

async function vote(c: string, r: number, voter: string, block = 1n) {
  await db.execute(sql`
    insert into chain.vote (campaign, round, voter, approve, weight, tx_hash, log_index, block_number, block_time)
    values (${c}, ${r}, ${voter}, true, 100000000, ${hex32()}, 0, ${block.toString()}, ${NOW.toString()})
  `);
}

const queuedFor = async (userId: string) =>
  (await db.select().from(notifications).where(eq(notifications.userId, userId))).map((r) => ({ kind: r.kind, key: r.dedupeKey, data: r.data }));

beforeAll(async () => {
  await ensureFakeChain(db);
  starter = await user();
});

afterAll(async () => {
  for (const a of chainAddresses) await deleteFakeChainRows(db, a);
  await db.delete(schema.campaignReferrals).where(inArray(schema.campaignReferrals.userId, userIds));
  await db.delete(notifications).where(inArray(notifications.userId, userIds));
  await db.delete(notificationPreferences).where(inArray(notificationPreferences.userId, userIds));
  await db.delete(pointsLedger).where(inArray(pointsLedger.userId, userIds));
  await db.delete(userLevels).where(inArray(userLevels.userId, userIds));
  await db.delete(schema.ratings).where(inArray(schema.ratings.userId, userIds));
  await db.delete(campaigns).where(inArray(campaigns.onchainAddress, chainAddresses));
  await db.delete(schema.orgMembers).where(inArray(schema.orgMembers.userId, userIds));
  if (extraOrgs.length > 0) await db.delete(schema.organizations).where(inArray(schema.organizations.id, extraOrgs));
  await db.update(users).set({ referredByUserId: null }).where(inArray(users.id, userIds));
  await db.delete(userAddresses).where(inArray(userAddresses.userId, userIds));
  await db.delete(users).where(inArray(users.id, userIds));
  await db.$client.end();
});

// Proof of Charity v2 (ADR-057, TASK-056). Each test uses its own campaigns
// and users; balances are checked per user, so rows of other tests do not matter.
const U = 1_000_000n;
let block = BigInt(Date.now()) * 10_000n; // above anything other test files write

async function donate(c: string, donor: string, amount: bigint, opts: { at?: bigint } = {}) {
  block += 10n;
  await db.execute(sql`
    insert into chain.donation (id, campaign, donor, amount, preference, sub_pool_id, tx_hash, log_index, block_number, block_time)
    values (${hex32()}, ${c}, ${donor}, ${amount.toString()}, 0, 0, ${hex32()}, 0, ${block.toString()}, ${(opts.at ?? NOW).toString()})
  `);
  await db.execute(sql`
    insert into chain.campaign_donor (campaign, donor, donated, preference, sub_pool_id, settled)
    values (${c}, ${donor}, ${amount.toString()}, 0, 0, false)
    on conflict (campaign, donor) do update set donated = chain.campaign_donor.donated + excluded.donated
  `);
}

async function castVote(c: string, r: number, voter: string) {
  block += 10n;
  await vote(c, r, voter, block);
}

const status = async (userId: string) => {
  const rows = await db.select().from(pointsLedger).where(eq(pointsLedger.userId, userId));
  return rows.filter((r) => r.bucket === "STATUS" && r.voidedAt === null).map((r) => [r.reason, Number(r.delta), r.refKey] as const);
};
const sumOf = async (userId: string) => (await status(userId)).reduce((t, [, d]) => t + d, 0);
const campaignIdOf = async (address: string) =>
  (await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.onchainAddress, address)))[0]!.id;
const extraOrgs: string[] = [];

describe("points (ADR-057)", () => {
  it("registration 50 for real accounts only; votes 30 per (user, campaign, round), whatever number of addresses voted", async () => {
    const u = await user({ privy: true });
    const ghost = await user(); // no Privy id: erased or never signed in
    const [a1, a2] = [await link(u), await link(u)];
    const c = await campaign({ state: "VOTING" });
    await castVote(c, 1, a1);
    await castVote(c, 1, a2); // same round: no extra points
    await castVote(c, 2, a1);
    const cursor = newPointsCursor();
    await awardPoints(db, cursor);
    expect((await status(u)).sort()).toEqual([
      ["REGISTRATION", 50, "registration"],
      ["VOTE", 30, `vote2:${c}:1`],
      ["VOTE", 30, `vote2:${c}:2`],
    ]);
    expect(await status(ghost)).toEqual([]);
    // Idempotent: the same tick again changes nothing.
    await awardPoints(db, cursor);
    expect(await sumOf(u)).toBe(110);
    const [level] = await db.select().from(userLevels).where(eq(userLevels.userId, u));
    expect([level!.statusPoints, level!.rewardPoints]).toEqual([110n, 110n]);
  });

  it("donation points: 10·√USDC of the total per campaign, credited as the increase, capped at 100; first donation 100 once", async () => {
    const u = await user({ privy: true });
    const [a1, a2] = [await link(u), await link(u)];
    const c1 = await campaign({ state: "LIVE" });
    const c2 = await campaign({ state: "LIVE" });
    const cursor = newPointsCursor();
    await donate(c1, a1, 1n * U);
    await awardPoints(db, cursor);
    expect((await status(u)).filter(([r]) => r !== "REGISTRATION").sort()).toEqual([
      ["DONATION", 10, `donation:${c1}:10`],
      ["FIRST_DONATION", 100, "first-donation"],
    ]);
    // Three more USDC from the other address → total 4 → 20 points: +10.
    await donate(c1, a2, 3n * U);
    await awardPoints(db, cursor, Date.now() + 60_000);
    expect((await status(u)).filter(([r]) => r === "DONATION").sort()).toEqual([
      ["DONATION", 10, `donation:${c1}:10`],
      ["DONATION", 10, `donation:${c1}:20`],
    ]);
    // A big gift to another campaign: capped at 100; no second first-donation.
    await donate(c2, a1, 50_000n * U);
    await awardPoints(db, cursor, Date.now() + 120_000);
    const rows = await status(u);
    expect(rows.filter(([r]) => r === "DONATION").reduce((t, [, d]) => t + d, 0)).toBe(120);
    expect(rows.filter(([r]) => r === "FIRST_DONATION")).toHaveLength(1);
    // Splitting a gift earns nothing extra: 4 × 1 USDC = √4·10 = 20, not 40.
    const v = await user({ privy: true });
    const va = await link(v);
    const c3 = await campaign({ state: "LIVE" });
    for (let i = 0; i < 4; i++) await donate(c3, va, 1n * U);
    await awardPoints(db, newPointsCursor());
    expect((await status(v)).filter(([r]) => r === "DONATION").reduce((t, [, d]) => t + d, 0)).toBe(20);
  });

  it("nothing for donations to your own campaign or your organisation's", async () => {
    const owner = await user({ privy: true });
    const ownerAddr = await link(owner);
    const [org] = await db.insert(schema.organizations).values({
      source: "REGISTERED", name: `Worker org ${RUN}`, country: "SI", registry: "NONE", causes: ["animals"], kybStatus: "APPROVED",
    }).returning({ id: schema.organizations.id });
    extraOrgs.push(org!.id);
    await db.insert(schema.orgMembers).values({ orgId: org!.id, userId: owner, role: "ORG_ADMIN" });
    const c = await campaign({ state: "SUCCEEDED" });
    await db.update(campaigns).set({ orgId: org!.id, beneficiaryType: "ORGANIZATION" }).where(eq(campaigns.onchainAddress, c));
    await donate(c, ownerAddr, 100n * U);
    await awardPoints(db, newPointsCursor());
    expect((await status(owner)).map(([r]) => r)).toEqual(["REGISTRATION"]);
  });

  it("a donor through your link: 20 per new donor and campaign, only for a donation after the visit, at most 10, never an erased referrer", async () => {
    const referrer = await user({ privy: true });
    const c = await campaign({ state: "LIVE" });
    const cid = await campaignIdOf(c);
    const later = async (minutesAfterVisit: number) => {
      const d = await user({ privy: true });
      const a = await link(d);
      const [row] = await db.insert(schema.campaignReferrals).values({ userId: d, campaignId: cid, referrerUserId: referrer })
        .returning({ createdAt: schema.campaignReferrals.createdAt });
      await donate(c, a, 2n * U, { at: BigInt(Math.floor(row!.createdAt.getTime() / 1000) + minutesAfterVisit * 60) });
      return d;
    };
    const before = await later(-10); // gave before the visit: no credit
    const donors = [];
    for (let i = 0; i < 11; i++) donors.push(await later(5));
    await awardPoints(db, newPointsCursor());
    const links = (await status(referrer)).filter(([r]) => r === "REFERRAL");
    expect(links).toHaveLength(10); // the cap
    expect(links.every(([, d, k]) => d === 20 && k!.startsWith(`link:${c}:`))).toBe(true);
    expect(links.some(([, , k]) => k === `link:${c}:${before}`)).toBe(false);
    // Erased referrer (no Privy id): nothing.
    const gone = await user();
    const d = await user({ privy: true });
    const a = await link(d);
    await db.insert(schema.campaignReferrals).values({ userId: d, campaignId: cid, referrerUserId: gone });
    await donate(c, a, 2n * U, { at: NOW + 3600n });
    await awardPoints(db, newPointsCursor());
    expect(await status(gone)).toEqual([]);
  });

  it("a friend who joined through your link and then gave: 100 to you, 50 to the friend, once", async () => {
    const referrer = await user({ privy: true });
    const friend = await user({ privy: true, referredBy: referrer });
    const a = await link(friend);
    const c1 = await campaign({ state: "LIVE" });
    const c2 = await campaign({ state: "LIVE" });
    await donate(c1, a, 1n * U, { at: NOW + 60n });
    await donate(c2, a, 1n * U, { at: NOW + 120n });
    await awardPoints(db, newPointsCursor());
    expect((await status(referrer)).filter(([r]) => r === "REFERRAL")).toEqual([["REFERRAL", 100, `friend:${friend}`]]);
    expect((await status(friend)).filter(([r]) => r === "REFERRAL")).toEqual([["REFERRAL", 50, "friend-bonus"]]);
  });

  it("supported campaign succeeds: 20, on the full pass only", async () => {
    const u = await user({ privy: true });
    const a = await link(u);
    const live = await campaign({ state: "LIVE" });
    const won = await campaign({ state: "PAYING" });
    await donate(live, a, 1n * U);
    await donate(won, a, 1n * U);
    const cursor = newPointsCursor();
    await awardPoints(db, cursor, 1_000_000); // first tick = full pass
    expect((await status(u)).filter(([r]) => r === "CAMPAIGN_SUCCESS")).toEqual([["CAMPAIGN_SUCCESS", 20, `success:${won}`]]);
    await db.execute(sql`update chain.campaign set state = 'COMPLETED' where address = ${live}`);
    await awardPoints(db, cursor, 1_060_000); // minute tick: states are not watched
    expect((await status(u)).filter(([r]) => r === "CAMPAIGN_SUCCESS")).toHaveLength(1);
    expect((await awardPoints(db, cursor, 1_000_000 + 6 * 3600_000)).full).toBe(true);
    expect((await status(u)).filter(([r]) => r === "CAMPAIGN_SUCCESS")).toHaveLength(2);
  });

  it("a signed rating: 20 once per campaign, on the next minute tick; nothing unsigned or for your own organisation (ADR-058)", async () => {
    const owner = await user({ privy: true });
    const rater = await user({ privy: true });
    const [org] = await db.insert(schema.organizations).values({
      source: "REGISTERED", name: `Worker rated org ${RUN}`, country: "SI", registry: "NONE", causes: ["animals"], kybStatus: "APPROVED",
    }).returning({ id: schema.organizations.id });
    extraOrgs.push(org!.id);
    await db.insert(schema.orgMembers).values({ orgId: org!.id, userId: owner, role: "ORG_ADMIN" });
    const [c1, c2] = [await campaign({ state: "COMPLETED" }), await campaign({ state: "FAILED" })];
    await db.update(campaigns).set({ orgId: org!.id, beneficiaryType: "ORGANIZATION" }).where(inArray(campaigns.onchainAddress, [c1, c2]));
    const [id1, id2] = [await campaignIdOf(c1), await campaignIdOf(c2)];
    const rate = (userId: string, campaignId: string, signed = true) =>
      db.insert(schema.ratings).values({
        orgId: org!.id, campaignId, userId, stars: 4, signature: signed ? "0xsigned" : null, signerAddress: signed ? addr() : null,
      });
    const t0 = Date.now();
    const cursor = newPointsCursor();
    await awardPoints(db, cursor, t0); // full pass: watermarks set
    await rate(rater, id1);
    await rate(owner, id1); // own organisation
    await rate(rater, id2, false); // erased: no signature
    const tick = await awardPoints(db, cursor, t0 + 60_000);
    expect(tick.full).toBe(false);
    expect(tick.awarded.rating).toBe(1);
    expect((await status(rater)).filter(([r]) => r === "RATING")).toEqual([["RATING", 20, `rating:${id1}`]]);
    expect((await status(owner)).filter(([r]) => r === "RATING")).toEqual([]);
    // Changing the rating (same row) or another tick adds nothing.
    await db.update(schema.ratings).set({ stars: 2 }).where(eq(schema.ratings.userId, rater));
    await awardPoints(db, cursor, t0 + 120_000);
    await awardPoints(db, newPointsCursor());
    expect((await status(rater)).filter(([r]) => r === "RATING")).toHaveLength(1);
  });

  it("minute ticks read only new chain rows and new users; the six-hour pass catches the rest", async () => {
    const t0 = Date.now();
    const cursor = newPointsCursor();
    await awardPoints(db, cursor, t0); // full pass, sets the watermarks
    const c = await campaign({ state: "LIVE" });
    // A donation below the window (an address linked later, or a rebuild gap)…
    const late = await user({ privy: true });
    const lateAddr = await link(late);
    await db.execute(sql`
      insert into chain.donation (id, campaign, donor, amount, preference, sub_pool_id, tx_hash, log_index, block_number, block_time)
      values (${hex32()}, ${c}, ${lateAddr}, 1000000, 0, 0, ${hex32()}, 0, ${(cursor.donationBlock! - OVERLAP_BLOCKS - 1n).toString()}, ${NOW.toString()})
    `);
    await db.execute(sql`insert into chain.campaign_donor (campaign, donor, donated, preference, sub_pool_id, settled) values (${c}, ${lateAddr}, 1000000, 0, 0, false)`);
    // …and a new one inside it.
    const fresh = await user({ privy: true });
    await donate(c, await link(fresh), 1n * U);
    const tick = await awardPoints(db, cursor, t0 + 60_000);
    expect(tick.full).toBe(false);
    expect((await status(fresh)).map(([r]) => r).sort()).toEqual(["DONATION", "FIRST_DONATION", "REGISTRATION"]);
    expect((await status(late)).map(([r]) => r)).toEqual(["REGISTRATION"]); // a new user, but the donation is below the window
    expect((await awardPoints(db, cursor, t0 + FULL_SWEEP_MS)).full).toBe(true);
    expect((await status(late)).map(([r]) => r).sort()).toEqual(["DONATION", "FIRST_DONATION", "REGISTRATION"]);
  });
});

describe("email queue", () => {
  it("vote opened: only donors who can receive email; old rounds are not mailed; idempotent", async () => {
    const withEmail = await user({ email: `a-${RUN}@example.com` });
    const noEmail = await user();
    const unsubscribed = await user({ email: `c-${RUN}@example.com`, prefs: { emailEnabled: false } });
    const walletOnly = await user({ prefs: { contactEmail: `d-${RUN}@example.com` } });
    const c = await campaign({ state: "VOTING" }, `<b>Shelter</b> ${RUN}`);
    for (const u of [withEmail, noEmail, unsubscribed, walletOnly]) await donor(c, await link(u));
    await round(c, 1, { opened: NOW - 100n, voteEnd: NOW + 3600n });
    const old = await campaign({ state: "VOTING" });
    await donor(old, await link(withEmail));
    // Opened 3 days ago, closes in 3 days: too old for "opened", too early for the reminder.
    await round(old, 1, { opened: NOW - 3n * 86_400n, voteEnd: NOW + 3n * 86_400n });

    const first = await enqueueLifecycle(db, NOW);
    expect(first.voteOpened).toBeGreaterThanOrEqual(2);
    const queued = await queuedFor(withEmail);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "VOTE_OPENED", key: `vote:${c}:1` });
    expect(queued[0]!.data).toMatchObject({ campaignTitle: `<b>Shelter</b> ${RUN}`, round: 1, voteEnd: (NOW + 3600n).toString() });
    expect(queued[0]!.data).toHaveProperty("slug", expect.stringMatching(new RegExp(`^worker-${RUN}-`)));
    expect((await queuedFor(walletOnly)).map((q) => q.kind)).toEqual(["VOTE_OPENED"]);
    expect(await queuedFor(noEmail)).toEqual([]);
    expect(await queuedFor(unsubscribed)).toEqual([]);
    // No 24 h reminder for a 1-hour (test) window.
    expect((await enqueueLifecycle(db, NOW)).voteOpened).toBe(0);
    expect((await queuedFor(withEmail)).length).toBe(1);
  });

  it("reminder 24 h before the end of a long vote, only to donors who have not voted; result; refund", async () => {
    const waiting = await user({ email: `w-${RUN}@example.com` });
    const voted = await user({ email: `v-${RUN}@example.com` });
    const c = await campaign({ state: "VOTING" });
    const [aw, av] = [await link(waiting), await link(voted)];
    await donor(c, aw);
    await donor(c, av);
    await round(c, 1, { opened: NOW - 6n * 86_400n, voteEnd: NOW + 3600n });
    await vote(c, 1, av);
    await enqueueLifecycle(db, NOW);
    expect((await queuedFor(waiting)).map((q) => q.kind)).toEqual(["VOTE_REMINDER"]);
    expect(await queuedFor(voted)).toEqual([]);

    const closed = await campaign({ state: "REJECTED", settlement_start: Number(NOW - 60n) });
    const ar = await link(waiting);
    await donor(closed, ar, 0);
    await donor(closed, await link(voted), 1, true); // already settled: nothing to do
    await round(closed, 1, { opened: NOW - 7n * 86_400n, voteEnd: NOW - 120n, outcome: "REJECTED", closedAt: NOW - 60n });
    await enqueueLifecycle(db, NOW);
    const kinds = await queuedFor(waiting);
    expect(kinds.map((q) => q.kind).sort()).toEqual(["REFUND_AVAILABLE", "VOTE_REMINDER", "VOTE_RESULT"]);
    expect(kinds.find((q) => q.kind === "REFUND_AVAILABLE")!.data).toMatchObject({ state: "REJECTED", refund: true, pool: false });
    expect(kinds.find((q) => q.kind === "VOTE_RESULT")!.data).toMatchObject({ outcome: "REJECTED", round: 1 });
    expect((await queuedFor(voted)).map((q) => q.kind)).toEqual(["VOTE_RESULT"]);
  });
});

describe("sending", () => {
  const collect = () => {
    const sent: OutgoingEmail[] = [];
    const mailer: Mailer = { async send(e) { sent.push(e); } };
    return { sent, mailer };
  };
  const status = async (id: string) => (await db.select().from(notifications).where(eq(notifications.id, id)))[0]!;
  const queue = async (userId: string, kind: "VOTE_OPENED" | "EMAIL_CONFIRM", data: Record<string, unknown>, createdAt = new Date()) =>
    (await db.insert(notifications).values({ userId, kind, dedupeKey: `t:${RUN}:${++n}`, data, createdAt, sendAfter: createdAt }).returning({ id: notifications.id }))[0]!.id;

  it("sends with an unsubscribe link and header, skips the unsubscribed and the stale, removes the confirm token", async () => {
    const reader = await user({ email: `r-${RUN}@example.com` });
    const gone = await user({ email: `g-${RUN}@example.com`, prefs: { emailEnabled: false } });
    const wallet = await user();
    const ok = await queue(reader, "VOTE_OPENED", { campaignTitle: "<b>Roof</b>", slug: "roof", round: 1, voteEnd: "1791100000" });
    const off = await queue(gone, "VOTE_OPENED", { campaignTitle: "Roof", slug: "roof", round: 1 });
    const stale = await queue(reader, "VOTE_OPENED", { campaignTitle: "Old", slug: "old", round: 1 }, new Date(Date.now() - 4 * 86_400_000));
    const confirm = await queue(wallet, "EMAIL_CONFIRM", { email: `new-${RUN}@example.com`, token: "secret-token" });

    const { sent, mailer } = collect();
    // Only this test's rows: other test files may queue rows too; loop until ours are done.
    for (let i = 0; i < 10; i++) {
      const r = await sendPending(db, mailer, { appBaseUrl: BASE });
      if (r.sent + r.skipped + r.failed === 0) break;
    }
    const mine = sent.filter((e) => [`r-${RUN}@example.com`, `new-${RUN}@example.com`, `g-${RUN}@example.com`].includes(e.to));
    expect(mine.map((e) => e.to).sort()).toEqual([`new-${RUN}@example.com`, `r-${RUN}@example.com`]);

    const vote = mine.find((e) => e.to === `r-${RUN}@example.com`)!;
    const [prefs] = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, reader));
    expect(vote.subject).toBe("Your vote is needed: <b>Roof</b>");
    expect(vote.html).toContain("&lt;b&gt;Roof&lt;/b&gt;");
    expect(vote.html).not.toContain("<b>Roof</b>");
    expect(vote.text).toContain(`${BASE}/en/campaigns/roof#evidence`);
    expect(vote.text).toContain(`${BASE}/en/notifications/unsubscribe?token=${prefs!.unsubscribeToken}`);
    expect(vote.headers).toEqual({
      "List-Unsubscribe": `<${BASE}/api/notifications/unsubscribe?token=${prefs!.unsubscribeToken}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    const confirmMail = mine.find((e) => e.to === `new-${RUN}@example.com`)!;
    expect(confirmMail.text).toContain(`${BASE}/api/notifications/confirm?token=secret-token`);
    expect(confirmMail.headers).toEqual({});

    expect(await status(ok)).toMatchObject({ status: "SENT", attempts: 1 });
    expect(await status(off)).toMatchObject({ status: "SKIPPED", lastError: "unsubscribed" });
    expect(await status(stale)).toMatchObject({ status: "SKIPPED", lastError: "expired" });
    const c = await status(confirm);
    expect(c.status).toBe("SENT");
    expect(c.data).toEqual({ email: `new-${RUN}@example.com` });
  });

  it("a failing server backs off and gives up after the last attempt", async () => {
    const u = await user({ email: `f-${RUN}@example.com` });
    const id = await queue(u, "VOTE_OPENED", { campaignTitle: "Roof", slug: "roof", round: 1 });
    const failing: Mailer = { async send(e) { if (e.to === `f-${RUN}@example.com`) throw new Error("454 4.7.0 TLS not available"); } };
    let now = new Date();
    await sendPending(db, failing, { appBaseUrl: BASE, now });
    let row = await status(id);
    expect(row).toMatchObject({ status: "PENDING", attempts: 1, lastError: "454 4.7.0 TLS not available" });
    expect(row.sendAfter.getTime() - now.getTime()).toBe(5 * 60_000);
    for (let i = 2; i <= MAX_ATTEMPTS; i++) {
      now = new Date(row.sendAfter.getTime() + 1000);
      await sendPending(db, failing, { appBaseUrl: BASE, now });
      row = await status(id);
    }
    expect(row).toMatchObject({ status: "FAILED", attempts: MAX_ATTEMPTS });
  });
});

describe("templates", () => {
  it("every kind has a subject, a call to action and (except the confirmation) an unsubscribe line", () => {
    const links = { base: BASE, unsubscribe: `${BASE}/en/notifications/unsubscribe?token=t` };
    for (const kind of ["VOTE_OPENED", "VOTE_REMINDER", "VOTE_RESULT", "REFUND_AVAILABLE"] as const) {
      const e = renderEmail(kind, { campaignTitle: "Roof", slug: "roof", round: 1, voteEnd: "1791100000", outcome: "PAYING", state: "FAILED", refund: true }, links);
      expect(e.subject, kind).toContain("Roof");
      expect(e.text, kind).toContain("Stop these emails");
      expect(e.html, kind).toContain(`href="${BASE}`);
    }
    expect(renderEmail("VOTE_RESULT", { campaignTitle: "Roof", round: 1, outcome: "NEEDS_REVIEW" }, links).text).toContain("CHERR.IO is now reviewing");
    expect(renderEmail("REFUND_AVAILABLE", { campaignTitle: "Roof", state: "REJECTED", refund: false, pool: true }, links).text).toContain("Emergency Pool");
  });
});

describe("queries", () => {
  it("compare the lower-case hex columns as they are, never through lower() (TASK-047: lower() defeats the indexes)", () => {
    for (const file of ["../src/notify/enqueue.ts", "../src/points.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
      expect({ file, lower: source.match(/lower\(/g) ?? [] }).toEqual({ file, lower: [] });
    }
  });
});

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { awardVotePoints } from "../src/points.js";
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

async function user(opts: { email?: string | null; prefs?: { emailEnabled?: boolean; contactEmail?: string } } = {}) {
  const [u] = await db.insert(users).values({ displayName: `Worker ${RUN} ${++n}`, email: opts.email ?? null }).returning({ id: users.id });
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

async function vote(c: string, r: number, voter: string) {
  await db.execute(sql`
    insert into chain.vote (campaign, round, voter, approve, weight, tx_hash, log_index, block_number, block_time)
    values (${c}, ${r}, ${voter}, true, 100000000, ${hex32()}, 0, 1, ${NOW.toString()})
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
  await db.delete(notifications).where(inArray(notifications.userId, userIds));
  await db.delete(notificationPreferences).where(inArray(notificationPreferences.userId, userIds));
  await db.delete(pointsLedger).where(inArray(pointsLedger.userId, userIds));
  await db.delete(userLevels).where(inArray(userLevels.userId, userIds));
  await db.delete(campaigns).where(inArray(campaigns.onchainAddress, chainAddresses));
  await db.delete(userAddresses).where(inArray(userAddresses.userId, userIds));
  await db.delete(users).where(inArray(users.id, userIds));
  await db.$client.end();
});

describe("vote points", () => {
  it("200 points per (user, campaign, round) in both balances, once, whatever number of addresses voted", async () => {
    const u = await user();
    const [a1, a2] = [await link(u), await link(u)];
    const c = await campaign({ state: "VOTING" });
    await vote(c, 1, a1);
    await vote(c, 1, a2); // same user, same round: no extra points
    await vote(c, 2, a1);
    await vote(c, 1, addr()); // an address no user owns
    await awardVotePoints(db);
    const rows = await db.select().from(pointsLedger).where(eq(pointsLedger.userId, u));
    expect(rows.map((r) => [r.bucket, r.delta, r.reason, r.refKey]).sort()).toEqual([
      ["REWARD", 200n, "VOTE", `vote:${c}:1`], ["REWARD", 200n, "VOTE", `vote:${c}:2`],
      ["STATUS", 200n, "VOTE", `vote:${c}:1`], ["STATUS", 200n, "VOTE", `vote:${c}:2`],
    ]);
    await awardVotePoints(db);
    expect(await db.select().from(pointsLedger).where(eq(pointsLedger.userId, u))).toHaveLength(4);
    const [level] = await db.select().from(userLevels).where(eq(userLevels.userId, u));
    expect([level!.statusPoints, level!.rewardPoints]).toEqual([400n, 400n]);
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
    const source = readFileSync(new URL("../src/notify/enqueue.ts", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
    expect(source.match(/lower\(/g) ?? []).toEqual([]);
  });
});

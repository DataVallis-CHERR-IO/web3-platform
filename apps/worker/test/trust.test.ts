import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { computeTrustScores, TRUST_SCORE_VERSION } from "../src/trust.js";
import { ensureFakeChain, deleteFakeChainRows } from "../../web/src/__tests__/helpers/fake-chain.js";

// TASK-017a (ADR-059): Trust Score v1 against Postgres with the fake chain views.

const url = process.env.DATABASE_URL;
if (!url) throw new Error("trust tests need DATABASE_URL");
const db = schema.createDb(url, { max: 2 });
const { organizations, campaigns, ratings, users, evidenceBundles, registryRecords, trustScores } = schema;
const RUN = Date.now().toString(36);
const addr = () => `0x${randomBytes(20).toString("hex")}`;
const hex32 = () => `0x${randomBytes(32).toString("hex")}`;
const U = 1_000_000n;
const orgIds: string[] = [];
const userIds: string[] = [];
const chainAddresses: string[] = [];
const recordIds: string[] = [];
let n = 0;

async function org(values: Partial<typeof organizations.$inferInsert>) {
  const [o] = await db.insert(organizations).values({
    source: "REGISTERED", name: `Trust ${RUN} ${++n}`, country: "SI", registry: "NONE", causes: ["animals"], kybStatus: "APPROVED", ...values,
  }).returning({ id: organizations.id });
  orgIds.push(o!.id);
  return o!.id;
}

async function user() {
  const [u] = await db.insert(users).values({ displayName: `Trust ${RUN} ${++n}` }).returning({ id: users.id });
  userIds.push(u!.id);
  return u!.id;
}

async function campaign(orgId: string, starter: string, chain: { state: string; raised: bigint; tranches?: number }) {
  const address = addr();
  chainAddresses.push(address);
  const [c] = await db.insert(campaigns).values({
    orgId, starterUserId: starter, beneficiaryType: "ORGANIZATION", title: `Trust campaign ${RUN} ${++n}`, slug: `trust-${RUN}-${n}`,
    story: { format: "plain", text: "Story. ".repeat(20) }, cause: "animals", country: "SI", targetEurCents: "1000000",
    durationDays: 30, status: "DEPLOYED", eurUsdRate: "1.17000000", rateSource: "ECB", rateAt: new Date(),
    targetUsdc: 1000n * U, beneficiaryAddress: addr(), deadline: new Date(), onchainAddress: address,
  }).returning({ id: campaigns.id });
  await db.execute(sql`
    insert into chain.campaign (address, offchain_id, beneficiary, beneficiary_type, target, deadline, tx_hash, log_index, block_number, block_time,
      state, total_raised, tranches_released)
    values (${address}, ${hex32()}, ${addr()}, 0, ${(1000n * U).toString()}, 1, ${hex32()}, 0, 1, 1, ${chain.state}, ${chain.raised.toString()}, ${chain.tranches ?? 0})
  `);
  return { id: c!.id, address };
}

async function round(address: string, r: number, outcome: string) {
  await db.execute(sql`
    insert into chain.vote_round (campaign, round, bundle_hash, vote_end, yes_votes, no_votes, outcome, closed_at, tx_hash, log_index, block_number, block_time)
    values (${address}, ${r}, ${hex32()}, 1, 0, 0, ${outcome}, 1, ${hex32()}, 0, 1, 1)
  `);
}

const score = async (orgId: string) =>
  (await db.select().from(trustScores).where(eq(trustScores.orgId, orgId)))[0];

let full: string, pending: string, fresh: string, demo: string, ukGood: string, ukRemoved: string, us: string, bad: string, starter: string;

beforeAll(async () => {
  await ensureFakeChain(db);
  starter = await user();
  full = await org({ country: "GB", causes: ["animals", "children"] });
  pending = await org({ kybStatus: "PENDING" });
  fresh = await org({});
  demo = await org({ isDemo: true });
  // full: 3 finished (COMPLETED, FAILED, SUCCEEDED) → 2/3; rounds PAYING + COMPLETED approved, NEEDS_REVIEW ignored → 1;
  // 3 tranches released, 2 bundles submitted (+1 draft) → 2/3; ratings 5 and 3 → (17.5 + 8) / 7 / 5.
  const c1 = await campaign(full, starter, { state: "COMPLETED", raised: 900n * U, tranches: 3 });
  await campaign(full, starter, { state: "FAILED", raised: 20n * U });
  const c3 = await campaign(full, starter, { state: "SUCCEEDED", raised: 300n * U });
  await campaign(full, starter, { state: "LIVE", raised: 5n * U });
  await round(c1.address, 1, "PAYING");
  await round(c1.address, 2, "COMPLETED");
  await round(c3.address, 1, "NEEDS_REVIEW");
  await db.insert(evidenceBundles).values([
    { campaignId: c1.id, round: 0, status: "APPROVED" },
    { campaignId: c1.id, round: 1, status: "SUBMITTED_ONCHAIN" },
    { campaignId: c1.id, round: 2, status: "DRAFT" },
  ]);
  const [r1, r2] = [await user(), await user()];
  await db.insert(ratings).values([
    { orgId: full, campaignId: c1.id, userId: r1, stars: 5 },
    { orgId: full, campaignId: c1.id, userId: r2, stars: 3 },
  ]);

  const recent = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10);
  ukGood = await org({ source: "IMPORTED", kybStatus: "NONE", country: "GB", registry: "UK_CC", registryId: `T${RUN}1`, website: "https://x.example", description: "We help." });
  ukRemoved = await org({ source: "IMPORTED", kybStatus: "NONE", country: "GB", registry: "UK_CC", registryId: `T${RUN}2` });
  us = await org({ source: "IMPORTED", kybStatus: "NONE", country: "US", registry: "US_IRS", registryId: `T${RUN}3` });
  bad = await org({ source: "IMPORTED", kybStatus: "NONE", country: "US", registry: "US_IRS", registryId: `T${RUN}4` });
  recordIds.push(`T${RUN}1`, `T${RUN}2`, `T${RUN}3`, `T${RUN}4`);
  await db.insert(registryRecords).values([
    { registry: "UK_CC", registryId: `T${RUN}1`, raw: { status: "Registered", income: 5000, financialYearEnd: recent } },
    { registry: "UK_CC", registryId: `T${RUN}2`, raw: { status: "Removed", income: 0 } },
    { registry: "US_IRS", registryId: `T${RUN}3`, raw: { revenue: 1000, taxPeriod: "201501" } },
    // Malformed register values: they count as missing and must not fail the pass for everyone.
    { registry: "US_IRS", registryId: `T${RUN}4`, raw: { revenue: "n/a", taxPeriod: "201913", financialYearEnd: "2023-02-30" } },
  ]);
});

afterAll(async () => {
  await db.delete(trustScores).where(inArray(trustScores.orgId, orgIds));
  await db.delete(ratings).where(inArray(ratings.orgId, orgIds));
  for (const a of chainAddresses) await deleteFakeChainRows(db, a);
  const own = await db.select({ id: campaigns.id }).from(campaigns).where(inArray(campaigns.orgId, orgIds));
  if (own.length > 0) await db.delete(evidenceBundles).where(inArray(evidenceBundles.campaignId, own.map((c) => c.id)));
  await db.delete(campaigns).where(inArray(campaigns.orgId, orgIds));
  await db.delete(registryRecords).where(inArray(registryRecords.registryId, recordIds));
  await db.delete(organizations).where(inArray(organizations.id, orgIds));
  await db.delete(users).where(inArray(users.id, userIds));
  await db.$client.end();
});

describe("Trust Score v1 (ADR-059)", () => {
  it("scores an organisation on CHERR.IO from ratings, outcomes, votes and evidence", async () => {
    await computeTrustScores(db, "all");
    const s = (await score(full))!;
    const rating = (5 * 3.5 + 8) / 7 / 5;
    const expected = 100 * (0.3 * rating + 0.25 * (2 / 3) + 0.2 * 1 + 0.15 * (2 / 3) + 0.1);
    expect(Number(s.score)).toBeCloseTo(expected, 1);
    expect(s).toMatchObject({ version: TRUST_SCORE_VERSION, listed: true, registered: true, country: "GB", causes: ["animals", "children"] });
    expect(s.raised).toBe(String(1225n * U));
    expect(s.components).toMatchObject({ kind: "registered", ratings: 2, finished: 3, succeeded: 2, decided: 2, approved: 2, released: 3, submitted: 2 });
  });

  it("uses the priors without history; lists neither pending nor demo organisations", async () => {
    expect(Number((await score(fresh))!.score)).toBe(61); // 100 × (0.3·0.7 + 0.25·0.5 + 0.2·0.5 + 0.15·0.5 + 0.1)
    expect((await score(pending))!.listed).toBe(false);
    expect((await score(pending))!.registered).toBe(false);
    expect((await score(demo))!.listed).toBe(false);
  });

  it("imported organisations: 20 + 20 × completeness, at most 40; removed ones are not listed", async () => {
    expect((await score(ukGood))!).toMatchObject({ score: "40.00", listed: true, registered: false });
    expect((await score(ukRemoved))!).toMatchObject({ score: "20.00", listed: false }); // nothing complete, removed
    // US: active, figures; no website, no description, last filing 2015 → 2 of 5.
    expect((await score(us))!).toMatchObject({ score: "28.00", listed: true, country: "US" });
    // Malformed values count as missing: active only → 1 of 5.
    expect((await score(bad))!).toMatchObject({ score: "24.00", listed: true });
  });

  it("scores imported organisations chunk by chunk with the same result", async () => {
    // Statement timeout on dev (30 s): the imported pass runs in id chunks. A chunk of 1 must still reach every row.
    await db.delete(trustScores).where(inArray(trustScores.orgId, [ukGood, ukRemoved, us, bad]));
    await computeTrustScores(db, "imported", { chunk: 1 });
    expect((await score(ukGood))!.score).toBe("40.00");
    expect((await score(ukRemoved))!.score).toBe("20.00");
    expect((await score(us))!.score).toBe("28.00");
    expect((await score(bad))!.score).toBe("24.00");
  });

  it("writes only what changed; a new rating moves the score on the next registered pass", async () => {
    // Other test files may add organisations meanwhile: check ours were not rewritten.
    const stamps = async () =>
      (await db.select({ id: trustScores.orgId, at: trustScores.computedAt }).from(trustScores).where(inArray(trustScores.orgId, orgIds)))
        .map((r) => `${r.id}:${r.at.toISOString()}`).sort();
    const first = await stamps();
    await computeTrustScores(db, "all");
    expect(await stamps()).toEqual(first);
    const before = Number((await score(fresh))!.score);
    const [c] = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.orgId, full)).limit(1);
    await db.insert(ratings).values({ orgId: fresh, campaignId: c!.id, userId: await user(), stars: 1 });
    const r = await computeTrustScores(db, "registered");
    // At least our rating; registry.test.ts may add a registered organisation at the same time.
    expect(r.written).toBeGreaterThanOrEqual(1);
    const after = await stamps();
    expect(after.filter((x) => !first.includes(x))).toHaveLength(1); // only `fresh` was rewritten among ours
    expect(Number((await score(fresh))!.score)).toBeLessThan(before);
  });
});

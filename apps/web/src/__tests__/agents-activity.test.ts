/**
 * TASK-061f: the public testnet page's data (`loadAgentActivity`). Real Postgres,
 * `chain.*` simulated by tables. The crew here is made of fresh random wallets
 * (never the real crew addresses, which agent-crew-marking.test.ts owns).
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray, sql } from "drizzle-orm";
import * as schema from "@cherrio/db";
import type { CrewEntry } from "@cherrio/shared/agent-crew";
import { getDb } from "@/lib/db";
import { loadAgentActivity } from "@/lib/agents/activity";
import { ensureFakeChain, deleteFakeChainRows } from "./helpers/fake-chain";
import { cleanUp, createOrganization, createUser, submit, type TestUser } from "./helpers/organizations";

const hex = (bytes: number) => `0x${randomBytes(bytes).toString("hex")}`;
const addr = () => hex(20) as `0x${string}`;

const crew: CrewEntry[] = [
  { index: 101, name: "staff", persona: "staff", address: addr() },
  { index: 102, name: "fundraiser-1", persona: "fundraiser", address: addr() },
  { index: 103, name: "donor-1", persona: "donor", address: addr() },
  { index: 104, name: "pool-1", persona: "pool", address: addr() },
  // A crew wallet whose user was never marked as an agent: its app actions must not count.
  { index: 105, name: "unmarked", persona: "fundraiser", address: addr() },
];
const stranger = addr();
const liveAddress = addr();
const realLiveAddress = addr();
const t0 = Math.floor(Date.now() / 1000) - 3_600;

let staff: TestUser;
let fundraiser: TestUser;
let unmarked: TestUser;
const campaignIds: Record<string, string> = {};

async function insertCampaign(
  user: TestUser, orgId: string, title: string, status: "DRAFT" | "PENDING_REVIEW" | "DEPLOYED", submittedAt: Date | null,
  opts: { demo?: boolean; onchain?: string | null } = {}
) {
  const [row] = await getDb()
    .insert(schema.campaigns)
    .values({
      orgId, starterUserId: user.id, beneficiaryType: "ORGANIZATION", title, isDemo: opts.demo ?? true,
      slug: `agents-${title}-${randomBytes(4).toString("hex")}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
      story: { format: "plain", text: "Test." }, cause: "animals", country: "SI", goalAmountMinor: "10000", durationDays: 21,
      status, submittedAt,
      ...(status === "DEPLOYED" ? {
        eurUsdRate: "1.17000000", rateSource: "ECB", rateAt: new Date(), targetUsdc: 117_000_000n,
        beneficiaryAddress: crew[1]!.address, deadline: new Date((t0 + 21 * 86_400) * 1000),
        onchainAddress: opts.onchain === undefined ? liveAddress : opts.onchain, deployedAt: new Date(),
      } : {}),
    })
    .returning({ id: schema.campaigns.id });
  campaignIds[title] = row!.id;
  return row!.id;
}

beforeAll(async () => {
  const db = getDb();
  await ensureFakeChain(db);
  staff = await createUser({ agent: true });
  fundraiser = await createUser({ agent: true });
  unmarked = await createUser({ agent: false });
  await db.insert(schema.userAddresses).values([
    { userId: staff.id, address: crew[0]!.address, kind: "EXTERNAL" },
    { userId: fundraiser.id, address: crew[1]!.address, kind: "EXTERNAL" },
    { userId: unmarked.id, address: crew[4]!.address, kind: "EXTERNAL" },
  ]);

  // Applications: the agent's counts, the unmarked user's does not.
  const crewApplication = await submit(fundraiser, { country: "TV" });
  const realApplication = await submit(unmarked, { country: "NR" });
  expect([crewApplication.status, realApplication.status]).toEqual([201, 201]);

  const org = await createOrganization(fundraiser);
  const unmarkedOrg = await createOrganization(unmarked);
  await insertCampaign(fundraiser, org.id, "draft only", "DRAFT", null);
  await insertCampaign(fundraiser, org.id, "in review", "PENDING_REVIEW", new Date((t0 + 100) * 1000));
  await insertCampaign(fundraiser, org.id, "live one", "DEPLOYED", new Date((t0 + 200) * 1000));
  // Public on Polygon, but not on chain yet: no title (the public rule needs both).
  await insertCampaign(fundraiser, org.id, "deployed not linked", "DEPLOYED", new Date((t0 + 250) * 1000), { onchain: null });
  // A real person's campaigns (not demo, starter not an agent).
  await insertCampaign(unmarked, unmarkedOrg.id, "not an agent", "PENDING_REVIEW", new Date((t0 + 300) * 1000), { demo: false });
  await insertCampaign(unmarked, unmarkedOrg.id, "real live", "DEPLOYED", new Date((t0 + 310) * 1000), { demo: false, onchain: realLiveAddress });

  await db.insert(schema.auditLog).values([
    { actorUserId: staff.id, action: "campaign.approve", entityType: "campaign", entityId: campaignIds["in review"], createdAt: new Date((t0 + 400) * 1000) },
    { actorUserId: staff.id, action: "campaign.publish_sent", entityType: "campaign", entityId: campaignIds["live one"], createdAt: new Date((t0 + 500) * 1000) },
    { actorUserId: staff.id, action: "kyb.approve", entityType: "kyb_submission", entityId: crewApplication.submissionId!, createdAt: new Date((t0 + 600) * 1000) },
    // The staff agent's decisions on a real person's work must never show (review, MEDIUM).
    { actorUserId: staff.id, action: "campaign.approve", entityType: "campaign", entityId: campaignIds["not an agent"], createdAt: new Date((t0 + 610) * 1000) },
    { actorUserId: staff.id, action: "campaign.publish_sent", entityType: "campaign", entityId: campaignIds["real live"], createdAt: new Date((t0 + 620) * 1000) },
    { actorUserId: staff.id, action: "kyb.approve", entityType: "kyb_submission", entityId: realApplication.submissionId!, createdAt: new Date((t0 + 630) * 1000) },
    // Not a decision shown on the page.
    { actorUserId: staff.id, action: "admin.mfa_verified", entityType: "user", entityId: staff.id, createdAt: new Date((t0 + 700) * 1000) },
    // A decision by a user who is not an agent.
    { actorUserId: unmarked.id, action: "campaign.approve", entityType: "campaign", entityId: campaignIds["not an agent"], createdAt: new Date((t0 + 800) * 1000) },
  ]);

  await db.execute(sql`
    insert into chain.campaign (address, offchain_id, beneficiary, beneficiary_type, target, deadline, state,
                                total_raised, tx_hash, log_index, block_number, block_time)
    values (${liveAddress}, ${hex(32)}, ${crew[1]!.address}, 0, 117000000, ${t0 + 21 * 86_400}, 'LIVE', 3500000, ${hex(32)}, 0, 1, ${t0})
  `);
  for (const [i, [donor, amount]] of ([[crew[2]!.address, 1_500_000n], [crew[2]!.address, 1_000_000n], [stranger, 1_000_000n]] as const).entries()) {
    await db.execute(sql`
      insert into chain.donation (id, campaign, donor, amount, preference, sub_pool_id, tx_hash, log_index, block_number, block_time)
      values (${`${liveAddress}-${i}`}, ${liveAddress}, ${donor}, ${amount.toString()}::numeric, 0, 0, ${hex(32)}, 0, ${10 + i}, ${t0 + 1_000 + i})
    `);
  }
  for (const [i, [donor, source]] of ([[crew[3]!.address, "DIRECT"], [crew[3]!.address, "CAMPAIGN"]] as const).entries()) {
    await db.execute(sql`
      insert into chain.pool_contribution (id, pool_id, donor, amount, source, campaign, tx_hash, log_index, block_number, block_time)
      values (${`agents-test-${crew[3]!.address}-${i}`}, 0, ${donor}, 1000000, ${source}, null, ${hex(32)}, 0, ${20 + i}, ${t0 + 2_000 + i})
    `);
  }
}, 60_000);

afterAll(async () => {
  const db = getDb();
  await deleteFakeChainRows(db, liveAddress);
  await deleteFakeChainRows(db, realLiveAddress);
  await db.execute(sql`delete from chain.pool_contribution where donor = ${crew[3]!.address}`);
  await db.delete(schema.userAddresses).where(inArray(schema.userAddresses.address, crew.map((c) => c.address)));
  await db.delete(schema.auditLog).where(inArray(schema.auditLog.actorUserId, [staff.id, unmarked.id]));
  await cleanUp();
});

describe("testnet agents' activity (loadAgentActivity)", () => {
  it("counts each agent's work from the chain, campaigns, applications and the audit log", async () => {
    const a = await loadAgentActivity(getDb(), crew);
    const by = Object.fromEntries(a.crew.map((s) => [s.entry.name, s]));

    expect(by["donor-1"]!.donations).toEqual({ count: 2, usdc: 2_500_000n });
    expect(by["pool-1"]!.poolGifts).toEqual({ count: 1, usdc: 1_000_000n }); // DIRECT only
    expect(by["fundraiser-1"]).toMatchObject({ organisationsApplied: 1, campaignsStarted: 3, campaignsLive: 1 });
    expect(by["staff"]).toMatchObject({ organisationsApproved: 1, campaignsApproved: 1, campaignsPublished: 1 });
    expect(by["unmarked"]).toMatchObject({ organisationsApplied: 0, campaignsStarted: 0, campaignsApproved: 0 });
    expect(a.totals).toMatchObject({
      donations: { count: 2, usdc: 2_500_000n }, poolGifts: { count: 1, usdc: 1_000_000n },
      organisationsApplied: 1, campaignsStarted: 3, campaignsLive: 1, organisationsApproved: 1, campaignsApproved: 1, campaignsPublished: 1,
    });
  });

  it("lists recent work newest first and names a campaign only while it is public", async () => {
    const a = await loadAgentActivity(getDb(), crew);
    const kinds = a.recent.map((r) => `${r.agent}:${r.kind}`);
    // Pool gift (t0+2000) and donations (t0+1001, t0+1000) are newest; the application is "now".
    expect(kinds).toContain("pool-1:pool");
    expect(kinds.filter((k) => k === "donor-1:donation")).toHaveLength(2);
    expect(kinds).not.toContain("unmarked:campaign_submitted");
    for (let i = 1; i < a.recent.length; i++) expect(a.recent[i - 1]!.at.getTime()).toBeGreaterThanOrEqual(a.recent[i]!.at.getTime());

    const approved = a.recent.find((r) => r.kind === "campaign_approved");
    const published = a.recent.find((r) => r.kind === "campaign_published");
    const reviewSubmitted = a.recent.find((r) => r.kind === "campaign_submitted" && r.at.getTime() === (t0 + 100) * 1000);
    expect(approved && "campaign" in approved ? approved.campaign : "missing").toBeNull(); // still in review: no title
    expect(reviewSubmitted && "campaign" in reviewSubmitted ? reviewSubmitted.campaign : "missing").toBeNull();
    expect(published && "campaign" in published ? published.campaign?.title : null).toBe("live one");
    const donation = a.recent.find((r) => r.kind === "donation");
    expect(donation && "campaign" in donation ? donation.campaign?.title : null).toBe("live one");
    const notLinked = a.recent.find((r) => r.kind === "campaign_submitted" && r.at.getTime() === (t0 + 250) * 1000);
    expect(notLinked && "campaign" in notLinked ? notLinked.campaign : "missing").toBeNull();
    const text = JSON.stringify(a.recent, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    for (const hidden of ["draft only", "real live", "not an agent", "deployed not linked"]) expect(text).not.toContain(hidden);
    expect(a.recent.filter((r) => r.kind === "campaign_published")).toHaveLength(1);
  });

  it("keeps to the limit and an empty crew", async () => {
    expect((await loadAgentActivity(getDb(), crew, 3)).recent).toHaveLength(3);
    expect(await loadAgentActivity(getDb(), [])).toMatchObject({ crew: [], recent: [] });
  });
});

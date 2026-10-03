import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray, sql } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { getDb } from "@/lib/db";
import {
  DONATIONS_PAGE_SIZE,
  donorName,
  getPublicCampaign,
  listCampaignDonations,
  listDonationThemes,
  listMyDonations,
  listPublicCampaigns,
  toPublicState,
} from "@/lib/campaigns/public";
import { GET as getMyDonations } from "@/app/api/donations/[campaign]/route";
import { daysLeft, percentRaised } from "@/components/campaigns/public-display";
import { cleanUp, createOrganization, createUser, PAYOUT_ADDRESS, type TestUser } from "./helpers/organizations";
import { deleteFakeChainRows, ensureFakeChain } from "./helpers/fake-chain";

// TASK-011a: the public read model. Real Postgres; `chain.*` stands in for the
// indexer views (helpers/fake-chain.ts).

const { campaigns, campaignMedia, emergencySubpools, userAddresses, users } = schema;
const RUN = Date.now().toString(36);
const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);
const addr = () => `0x${randomBytes(20).toString("hex")}`;
const tx = () => `0x${randomBytes(32).toString("hex")}`;

let owner: TestUser;
let orgId: string;
const created: { id: string; address: string | null }[] = [];
const addressRows: string[] = [];
let n = 0;

async function campaign(opts: {
  status?: "DEPLOYED" | "APPROVED" | "DRAFT";
  deadlineInDays: number;
  chain?: { state: string; raised?: bigint; payoutMode?: number | null; endTime?: number } | null;
  cover?: boolean;
}) {
  const address = opts.status === undefined || opts.status === "DEPLOYED" ? addr() : null;
  const deadline = new Date((now() + opts.deadlineInDays * DAY) * 1000);
  const [row] = await getDb()
    .insert(campaigns)
    .values({
      orgId,
      starterUserId: owner.id,
      beneficiaryType: "ORGANIZATION",
      title: `Public test ${RUN} ${++n}`,
      slug: `public-test-${RUN}-${n}`,
      story: { format: "plain", text: `Story ${n}. `.repeat(10) },
      cause: "animals",
      country: "SI",
      targetEurCents: "1000000",
      durationDays: 30,
      status: opts.status ?? "DEPLOYED",
      eurUsdRate: "1.17000000",
      rateSource: "ECB",
      rateAt: new Date(),
      targetUsdc: 11_700_000_000n,
      beneficiaryAddress: PAYOUT_ADDRESS.toLowerCase(),
      deadline,
      onchainAddress: address,
    })
    .returning({ id: campaigns.id, slug: campaigns.slug });
  created.push({ id: row!.id, address });
  if (opts.cover) {
    await getDb().insert(campaignMedia).values({
      campaignId: row!.id, kind: "COVER", cid: `covers/${row!.id}.webp`, storage: "HETZNER_PUBLIC", createdBy: owner.id,
    });
  }
  if (address && opts.chain) {
    await getDb().execute(sql`
      insert into chain.campaign (address, offchain_id, beneficiary, beneficiary_type, target, deadline, state,
                                  total_raised, payout_mode, end_time, tx_hash, log_index, block_number, block_time)
      values (${address}, ${tx()}, ${PAYOUT_ADDRESS.toLowerCase()}, 0, 11700000000, ${now() + opts.deadlineInDays * DAY}, ${opts.chain.state},
              ${(opts.chain.raised ?? 0n).toString()}::numeric, ${opts.chain.payoutMode ?? null}, ${opts.chain.endTime ?? 0},
              ${tx()}, 0, 1, ${now()})
    `);
  }
  return { id: row!.id, slug: row!.slug, address };
}

let block = 100;
async function donate(campaignAddress: string, donor: string, amount: bigint) {
  block += 1;
  await getDb().execute(sql`
    insert into chain.donation (id, campaign, donor, amount, preference, sub_pool_id, tx_hash, log_index, block_number, block_time)
    values (${`${campaignAddress}-${block}`}, ${campaignAddress}, ${donor}, ${amount.toString()}::numeric, 0, 0, ${tx()}, 0, ${block}, ${now()})
  `);
  await getDb().execute(sql`
    insert into chain.campaign_donor (campaign, donor, donated, preference, sub_pool_id)
    values (${campaignAddress}, ${donor}, ${amount.toString()}::numeric, 0, 0)
    on conflict (campaign, donor) do update set donated = chain.campaign_donor.donated + excluded.donated
  `);
}

async function setPreference(campaignAddress: string, donor: string, preference: number, subPoolId: number) {
  await getDb().execute(sql`
    update chain.campaign_donor set preference = ${preference}, sub_pool_id = ${subPoolId}
    where campaign = ${campaignAddress} and donor = ${donor}
  `);
}

async function linkAddress(userId: string, address: string) {
  await getDb().insert(userAddresses).values({ userId, address, kind: "EXTERNAL" });
  addressRows.push(address);
}

describe("public campaign read model (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("public campaign tests need DATABASE_URL");
    process.env.APP_ENV = "local";
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    await ensureFakeChain(getDb());
    owner = await createUser();
    orgId = (await createOrganization(owner)).id;
  });

  afterAll(async () => {
    const db = getDb();
    for (const c of created) if (c.address) await deleteFakeChainRows(db, c.address);
    if (addressRows.length > 0) await db.delete(userAddresses).where(inArray(userAddresses.address, addressRows));
    await cleanUp();
  });

  it("lists only DEPLOYED campaigns: live first by soonest deadline, then ended by latest end", async () => {
    const liveLater = await campaign({ deadlineInDays: 20, chain: { state: "LIVE" } });
    const liveSoon = await campaign({ deadlineInDays: 3, chain: { state: "LIVE" }, cover: true });
    const endedOld = await campaign({ deadlineInDays: -10, chain: { state: "SUCCEEDED", endTime: now() - 10 * DAY } });
    const endedNew = await campaign({ deadlineInDays: -1, chain: { state: "FAILED", endTime: now() - DAY } });
    const approved = await campaign({ status: "APPROVED", deadlineInDays: 5 });
    const draft = await campaign({ status: "DRAFT", deadlineInDays: 5 });

    const { campaigns: list, chainAvailable } = await listPublicCampaigns(getDb());
    expect(chainAvailable).toBe(true);
    const mine = list.filter((c) => c.title.startsWith(`Public test ${RUN}`)).map((c) => c.id);
    expect(mine).not.toContain(approved.id);
    expect(mine).not.toContain(draft.id);
    const order = [liveSoon.id, liveLater.id, endedNew.id, endedOld.id];
    expect(mine.filter((id) => order.includes(id))).toEqual(order);

    const soon = list.find((c) => c.id === liveSoon.id)!;
    expect(soon.onChain?.state).toBe("live");
    expect(soon.coverUrl).toMatch(new RegExp(`/covers/${liveSoon.id}\\.webp$`));
    expect(soon.targetUsdc).toBe(11_700_000_000n);
    expect(list.find((c) => c.id === endedNew.id)!.onChain?.state).toBe("failed");
  });

  it("returns a campaign by slug only when it is DEPLOYED", async () => {
    const live = await campaign({ deadlineInDays: 10, chain: { state: "LIVE", raised: 123_450_000n, payoutMode: null } });
    const approved = await campaign({ status: "APPROVED", deadlineInDays: 10 });
    const found = await getPublicCampaign(getDb(), live.slug);
    expect(found?.campaign.id).toBe(live.id);
    expect(found?.campaign.onChain?.raised).toBe(123_450_000n);
    expect(found?.campaign.story).toContain("Story");
    expect(await getPublicCampaign(getDb(), approved.slug)).toBeNull();
    expect(await getPublicCampaign(getDb(), `no-such-campaign-${RUN}`)).toBeNull();
  });

  it("a DEPLOYED campaign the indexer has not seen yet shows without on-chain figures", async () => {
    const pending = await campaign({ deadlineInDays: 10, chain: null });
    const found = await getPublicCampaign(getDb(), pending.slug);
    expect(found?.chainAvailable).toBe(true);
    expect(found?.campaign.onChain).toBeNull();
  });

  it("names donors per ADR-043: name, Anonymous, or the address of an unknown donor", async () => {
    const live = await campaign({ deadlineInDays: 10, chain: { state: "LIVE" } });
    const named = await createUser();
    const anon = await createUser();
    await getDb().update(users).set({ displayName: "Maja Novak" }).where(inArray(users.id, [named.id]));
    await getDb().update(users).set({ displayName: "Hidden Person", anonymousDonations: true }).where(inArray(users.id, [anon.id]));
    const namedAddr = addr();
    const anonAddr = addr();
    const unknownAddr = addr();
    await linkAddress(named.id, namedAddr);
    await linkAddress(anon.id, anonAddr);
    await donate(live.address!, namedAddr, 10_000_000n);
    await donate(live.address!, anonAddr, 20_000_000n);
    await donate(live.address!, unknownAddr, 30_000_000n);

    const ledger = await listCampaignDonations(getDb(), live.address!);
    expect(ledger?.total).toBe(3);
    // newest first
    expect(ledger!.donations.map((d) => d.donor)).toEqual([unknownAddr, anonAddr, namedAddr]);
    expect(ledger!.donations.map((d) => d.donorName)).toEqual([
      { kind: "unknown" },
      { kind: "anonymous" },
      { kind: "named", name: "Maja Novak" },
    ]);
    expect(ledger!.donations.map((d) => d.amount)).toEqual([30_000_000n, 20_000_000n, 10_000_000n]);
    // the anonymous donor's name never leaves the server
    expect(JSON.stringify(ledger, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("Hidden Person");

    const found = await getPublicCampaign(getDb(), live.slug);
    expect(found?.campaign.onChain?.donors).toBe(3);
  });

  it("TASK-011b: lists the user's own donations per linked address, with the failure preference", async () => {
    const live = await campaign({ deadlineInDays: 10, chain: { state: "LIVE" } });
    const donor = await createUser();
    const stranger = await createUser();
    const walletA = addr();
    const walletB = addr();
    await linkAddress(donor.id, walletA);
    await linkAddress(donor.id, walletB);
    await donate(live.address!, walletA, 5_000_000n);
    await donate(live.address!, walletA, 2_500_000n);
    await donate(live.address!, walletB, 1_000_000n);
    await donate(live.address!, addr(), 9_000_000n);
    await setPreference(live.address!, walletB, 1, 3);

    const mine = await listMyDonations(getDb(), donor.id, live.address!.toUpperCase().replace("0X", "0x"));
    expect(mine).toEqual([
      { address: walletA, donated: 7_500_000n, preference: 0, subPoolId: 0 },
      { address: walletB, donated: 1_000_000n, preference: 1, subPoolId: 3 },
    ]);
    expect(await listMyDonations(getDb(), stranger.id, live.address!)).toEqual([]);

    // The API route: only the session's own rows; amounts as strings.
    const call = (cookie: string | null, address: string) =>
      getMyDonations(
        new Request(`http://localhost:3000/api/donations/${address}`, { headers: cookie ? { cookie } : {} }),
        { params: Promise.resolve({ campaign: address }) }
      );
    const ok = await call(donor.cookie, live.address!);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      donations: [
        { address: walletA, donated: "7500000", preference: "REFUND", subPoolId: 0 },
        { address: walletB, donated: "1000000", preference: "EMERGENCY_POOL", subPoolId: 3 },
      ],
    });
    expect((await call(null, live.address!)).status).toBe(401);
    expect((await call(donor.cookie, "not-an-address")).status).toBe(400);
    expect(await (await call(stranger.cookie, live.address!)).json()).toEqual({ donations: [] });
  });

  it("TASK-011b: Emergency Pool themes are the seeded sub-pools that exist on chain (general pool excluded)", async () => {
    const ids = [9_101, 9_102, 9_103];
    const slugs = ids.map((id) => `test-${RUN}-${id}`);
    try {
      await getDb().insert(emergencySubpools).values(
        ids.map((poolId, i) => ({ poolId, slug: slugs[i]!, nameKey: `pool.${slugs[i]}.name`, descriptionKey: "x" }))
      );
      // 9101 and 9103 exist on chain; 9102 only in the app.
      await getDb().execute(sql`
        insert into chain.pool (id, balance, total_contributed) values (9101, 0, 0), (9103, 0, 0), (0, 0, 0)
        on conflict (id) do nothing
      `);
      const themes = (await listDonationThemes(getDb())).filter((th) => ids.includes(th.poolId));
      expect(themes).toEqual([
        { poolId: 9_101, slug: slugs[0] },
        { poolId: 9_103, slug: slugs[2] },
      ]);
      expect((await listDonationThemes(getDb())).some((th) => th.poolId === 0)).toBe(false);
    } finally {
      await getDb().execute(sql`delete from chain.pool where id in (9101, 9103)`);
      await getDb().delete(emergencySubpools).where(inArray(emergencySubpools.poolId, ids));
    }
  });

  it("donorName: unknown when no user row matched", () => {
    expect(donorName({ display_name: null, anonymous_donations: null })).toEqual({ kind: "unknown" });
    expect(donorName({ display_name: "A", anonymous_donations: false })).toEqual({ kind: "named", name: "A" });
    expect(donorName({ display_name: "A", anonymous_donations: true })).toEqual({ kind: "anonymous" });
  });

  it("paginates donations and clamps the page into range", async () => {
    const live = await campaign({ deadlineInDays: 10, chain: { state: "LIVE" } });
    for (let i = 0; i < DONATIONS_PAGE_SIZE + 2; i++) await donate(live.address!, addr(), 1_000_000n);
    const first = await listCampaignDonations(getDb(), live.address!);
    expect(first?.donations).toHaveLength(DONATIONS_PAGE_SIZE);
    expect(first?.pageCount).toBe(2);
    const last = await listCampaignDonations(getDb(), live.address!, { page: 99 });
    expect(last?.page).toBe(2);
    expect(last?.donations).toHaveLength(2);
    const bad = await listCampaignDonations(getDb(), live.address!, { page: Number("abc") });
    expect(bad?.page).toBe(1);
  });
});

describe("public state and display helpers", () => {
  it("maps chain states; LIVE past the deadline is 'ending'", () => {
    expect(toPublicState("LIVE", 200n, 100n)).toBe("live");
    expect(toPublicState("LIVE", 100n, 100n)).toBe("ending");
    expect(toPublicState("PAYING", 0n, 1n)).toBe("succeeded");
    expect(toPublicState("NEEDS_REVIEW", 0n, 1n)).toBe("needs-review");
    expect(toPublicState(null, 0n, 1n)).toBe("unknown");
    expect(toPublicState("SOMETHING_NEW", 0n, 1n)).toBe("unknown");
  });

  it("days left and percent raised", () => {
    const t0 = Date.UTC(2026, 9, 3, 12);
    expect(daysLeft(new Date(t0 + 3.5 * 86_400_000), t0)).toBe(3);
    expect(daysLeft(new Date(t0 + 1000), t0)).toBe(0);
    expect(daysLeft(new Date(t0), t0)).toBeNull();
    expect(percentRaised(5_000_000n, 10_000_000n)).toBe(50);
    expect(percentRaised(1n, 0n)).toBe(0);
  });
});

describe("without the indexer's chain views", () => {
  // A database stub: the query that touches chain.* fails like Postgres does
  // when the schema is missing (42P01 / 3F000); the app-only retry succeeds.
  const missing = Object.assign(new Error('relation "chain.campaign" does not exist'), { code: "42P01" });
  const appRow = {
    id: "c1", slug: "s1", title: "T", org_name: "Org", kyb_status: "APPROVED", cause: "animals", country: "SI",
    cover_cid: null, target_eur_cents: "100", target_usdc: "1170000", deadline: new Date().toISOString(), address: "0xabc",
    story: { text: "hello" },
  };
  function stub(results: Array<unknown[] | Error>) {
    const calls: number[] = [];
    return {
      calls,
      db: {
        execute: async () => {
          calls.push(calls.length);
          const next = results.shift();
          if (next instanceof Error) throw next;
          return next ?? [];
        },
      } as unknown as Parameters<typeof listPublicCampaigns>[0],
    };
  }

  it("the list falls back to app data and says the chain is unavailable", async () => {
    process.env.APP_ENV = "local";
    const { db } = stub([[{ n: 1 }], missing, [appRow]]);
    const result = await listPublicCampaigns(db);
    expect(result.chainAvailable).toBe(false);
    expect(result.campaigns).toHaveLength(1);
    expect(result.campaigns[0]!.onChain).toBeNull();
  });

  it("the page falls back too, and the ledger reports null instead of throwing", async () => {
    const { db } = stub([missing, [appRow]]);
    const page = await getPublicCampaign(db, "s1");
    expect(page?.chainAvailable).toBe(false);
    expect(page?.campaign.story).toBe("hello");
    const { db: db2 } = stub([Object.assign(new Error("schema missing"), { code: "3F000" })]);
    expect(await listCampaignDonations(db2, "0xabc")).toBeNull();
  });

  it("TASK-011b: themes and my donations degrade without the chain views", async () => {
    const { db } = stub([missing]);
    expect(await listDonationThemes(db)).toEqual([]);
    const { db: db2 } = stub([missing]);
    expect(await listMyDonations(db2, "u1", "0xabc")).toBeNull();
  });

  it("other database errors are not swallowed", async () => {
    const { db } = stub([[{ n: 1 }], Object.assign(new Error("syntax"), { code: "42601" })]);
    await expect(listPublicCampaigns(db)).rejects.toThrow("syntax");
  });
});

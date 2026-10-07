import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ORGANIZATION_CAUSES } from "@cherrio/shared";
import { getDb } from "@/lib/db";
import { getPublicCampaign, listCampaignDonations, listCampaignFacets, listPublicCampaigns } from "@/lib/campaigns/public";
import { getLandingCampaigns } from "@/lib/campaigns/landing";
import { campaignCounts, listCampaigns } from "@/lib/admin/campaigns";
import { listMyCampaignDonations } from "@/lib/campaigns/lifecycle";
import { ensureFakeChain } from "../__tests__/helpers/fake-chain";

// TASK-047: how fast the campaign lists are with thousands of campaigns.
// `pnpm --filter web perf:campaigns` — needs DATABASE_URL pointing at a
// migrated database whose name contains "perf" (it fills it with PERF_CAMPAIGNS
// published campaigns, default 10,000, each with 10 donors and a cover; never
// run it against the test database, whose tests count rows). The fake chain
// tables have the indexer's primary keys and indexes, like the real views.
// Each case runs 7 times; the median must stay under its budget (ms).

const N = Number(process.env.PERF_CAMPAIGNS ?? 10_000);
const DONORS_PER_CAMPAIGN = 10;
const HEAVY_DONOR = `0x${"f".repeat(40)}`; // gave to 300 campaigns
const COUNTRIES = ["SI", "HR", "AT", "DE", "IT", "FR", "ES", "GB", "US", "KE", "UG", "IN", "BR", "PH", "UA"];

async function seed() {
  const db = getDb();
  const dbName = ((await db.execute(sql`select current_database() as n`)) as unknown as { n: string }[])[0]!.n;
  if (!dbName.includes("perf")) throw new Error(`refusing to fill ${dbName}: use a database whose name contains "perf"`);
  await ensureFakeChain(db);
  const [have] = (await db.execute(sql`select count(*)::int as n from app.campaigns where slug like 'perf-%'`)) as unknown as { n: number }[];
  if (have!.n >= N) return;
  await db.execute(sql`delete from app.campaign_media where cid like 'perf-%'`);
  await db.execute(sql`delete from chain.donation where campaign in (select onchain_address from app.campaigns where slug like 'perf-%')`);
  await db.execute(sql`delete from chain.campaign_donor where campaign in (select onchain_address from app.campaigns where slug like 'perf-%')`);
  await db.execute(sql`delete from chain.campaign where address in (select onchain_address from app.campaigns where slug like 'perf-%')`);
  await db.execute(sql`delete from app.campaigns where slug like 'perf-%'`);

  const [user] = (await db.execute(sql`
    insert into app.users (id, display_name, privy_did) values (gen_random_uuid(), 'Perf user', 'perf|user')
    on conflict (privy_did) do update set display_name = excluded.display_name returning id
  `)) as unknown as { id: string }[];
  await db.execute(sql`
    insert into app.user_addresses (id, user_id, address, kind) values (gen_random_uuid(), ${user!.id}, ${HEAVY_DONOR}, 'EXTERNAL')
    on conflict (address) do nothing
  `);
  const [org] = (await db.execute(sql`
    insert into app.organizations (id, source, name, country, registry, causes, kyb_status)
    values (gen_random_uuid(), 'REGISTERED', 'Perf organisation', 'SI', 'NONE', '{}', 'APPROVED') returning id
  `)) as unknown as { id: string }[];
  const causes = sql.raw(`array[${ORGANIZATION_CAUSES.map((c) => `'${c}'`).join(",")}]`);
  const countries = sql.raw(`array[${COUNTRIES.map((c) => `'${c}'`).join(",")}]`);
  // 70 % live (deadline 1–60 days ahead), 30 % ended (1–90 days ago).
  await db.execute(sql`
    insert into app.campaigns (id, org_id, starter_user_id, beneficiary_type, beneficiary_address, title, slug, story, cause, country,
      target_eur_cents, target_usdc, duration_days, status, deadline, deployed_at, onchain_address)
    select gen_random_uuid(), ${org!.id}, ${user!.id}, 'ORGANIZATION', '0x' || repeat('a', 40), 'Perf campaign ' || i, 'perf-' || i,
      '{"format":"plain","text":"Perf"}', (${causes})[1 + i % ${ORGANIZATION_CAUSES.length}], (${countries})[1 + (i / 7) % ${COUNTRIES.length}],
      1000000, 1170000000, 30, 'DEPLOYED',
      case when i % 10 < 7 then now() + (1 + i % 60) * interval '1 day' else now() - (1 + i % 90) * interval '1 day' end,
      now() - interval '30 days', '0x' || lpad(to_hex(i), 40, '0')
    from generate_series(1, ${N}) i
  `);
  await db.execute(sql`
    insert into chain.campaign (address, offchain_id, beneficiary, beneficiary_type, target, deadline, state, tx_hash, log_index,
      block_number, block_time, total_raised, end_time)
    select c.onchain_address, '0x' || md5(c.slug), c.beneficiary_address, 0, 1170000000, extract(epoch from c.deadline)::bigint,
      case when c.deadline > now() then 'LIVE' when (substr(c.slug, 6)::int) % 2 = 0 then 'SUCCEEDED' else 'FAILED' end,
      '0x' || md5(c.slug) || md5(c.slug), 0, 1, extract(epoch from c.deployed_at)::bigint, (substr(c.slug, 6)::int % 1000) * 1000000,
      case when c.deadline > now() then 0 else extract(epoch from c.deadline)::bigint end
    from app.campaigns c where c.slug like 'perf-%'
  `);
  await db.execute(sql`
    insert into chain.campaign_donor (campaign, donor, donated, preference, sub_pool_id)
    select c.onchain_address, '0x' || lpad(to_hex(1000000 + (substr(c.slug, 6)::int * 7 + j) % 50000), 40, '0'), 5000000, 0, 0
    from app.campaigns c, generate_series(1, ${DONORS_PER_CAMPAIGN}) j where c.slug like 'perf-%'
  `);
  // One donation per donor row (the public ledger reads chain.donation).
  await db.execute(sql`
    insert into chain.donation (id, campaign, donor, amount, preference, sub_pool_id, tx_hash, log_index, block_number, block_time)
    select cd.campaign || '-' || cd.donor, cd.campaign, cd.donor, cd.donated, 0, 0, '0x' || md5(cd.campaign || cd.donor) || md5(cd.donor),
      0, row_number() over (), 1790000000
    from chain.campaign_donor cd join app.campaigns c on c.onchain_address = cd.campaign where c.slug like 'perf-%'
  `);
  await db.execute(sql`
    insert into chain.campaign_donor (campaign, donor, donated, preference, sub_pool_id)
    select c.onchain_address, ${HEAVY_DONOR}, 5000000, 0, 0 from app.campaigns c
    where c.slug like 'perf-%' and (substr(c.slug, 6)::int) % ${Math.max(1, Math.floor(N / 300))} = 0
    on conflict do nothing
  `);
  await db.execute(sql`
    insert into app.campaign_media (id, campaign_id, kind, cid, storage)
    select gen_random_uuid(), c.id, 'COVER', 'perf-cover-' || c.slug, 'HETZNER_PUBLIC' from app.campaigns c where c.slug like 'perf-%'
  `);
  await db.execute(sql`analyze`);
}

async function median(run: () => Promise<unknown>, times = 7): Promise<number> {
  await run(); // warm-up (connection, plan cache)
  const ms: number[] = [];
  for (let i = 0; i < times; i++) {
    const t = performance.now();
    await run();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  return Math.round(ms[Math.floor(times / 2)]! * 10) / 10;
}

const results: { name: string; ms: number; budget: number }[] = [];

describe(`campaign lists with ${N.toLocaleString("en")} published campaigns`, () => {
  let userId: string;
  let middleSlug: string;
  let busyAddress: string;

  beforeAll(async () => {
    await seed();
    const db = getDb();
    userId = ((await db.execute(sql`select id from app.users where privy_did = 'perf|user'`)) as unknown as { id: string }[])[0]!.id;
    middleSlug = `perf-${Math.floor(N / 2)}`;
    busyAddress = `0x${Math.floor(N / 2).toString(16).padStart(40, "0")}`;
  }, 600_000);

  const cases: [string, number, () => Promise<unknown>][] = [
    ["/campaigns page 1", 150, () => listPublicCampaigns(getDb(), { page: 1 })],
    ["/campaigns last page", 150, () => listPublicCampaigns(getDb(), { page: Math.ceil(N / 24) })],
    ["/campaigns cause + 2 countries", 150, () => listPublicCampaigns(getDb(), { page: 1, causes: ["medical"], countries: ["SI", "HR"] })],
    // TASK-053: the other orders and the text search.
    ["/campaigns sort newest", 150, () => listPublicCampaigns(getDb(), { page: 1, sort: "newest" })],
    ["/campaigns sort most raised", 150, () => listPublicCampaigns(getDb(), { page: 1, sort: "raised" })],
    ["/campaigns search", 150, () => listPublicCampaigns(getDb(), { page: 1, q: "campaign 77" })],
    ["filter facets (search)", 100, () => listCampaignFacets(getDb(), { q: "campaign 77" })],
    ["filter facets (no filter)", 100, () => listCampaignFacets(getDb(), {})],
    ["filter facets (cause + country)", 100, () => listCampaignFacets(getDb(), { causes: ["medical"], countries: ["SI"] })],
    ["landing (hero + grid)", 150, () => getLandingCampaigns(getDb())],
    ["campaign page", 50, () => getPublicCampaign(getDb(), middleSlug)],
    ["campaign page donor ledger", 50, () => listCampaignDonations(getDb(), busyAddress, { page: 1 })],
    ["admin campaigns (live view)", 100, () => listCampaigns(getDb(), { view: "live", q: "", country: "" }, null)],
    ["admin campaigns search", 150, () => listCampaigns(getDb(), { view: "all", q: "campaign 77", country: "" }, null)],
    ["admin campaign counts", 50, () => campaignCounts(getDb())],
    ["my donations (300 campaigns)", 500, () => listMyCampaignDonations(getDb(), userId)],
  ];

  for (const [name, budget, run] of cases) {
    it(`${name} — median under ${budget} ms`, async () => {
      const ms = await median(run);
      results.push({ name, ms, budget });
      console.log(`[perf] ${name.padEnd(34)} ${String(ms).padStart(8)} ms  (budget ${budget})`);
      expect(ms).toBeLessThan(budget);
    }, 120_000);
  }
});

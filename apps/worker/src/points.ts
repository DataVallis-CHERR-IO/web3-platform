import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@cherrio/db";
import { POINTS, POINTS_RULE_VERSION, SUCCEEDED_CAMPAIGN_STATES } from "@cherrio/shared/points";

// Proof of Charity points, v2 (ADR-057, TASK-056; v1 was ADR-048 / TASK-033e).
// Every entry is credited to both balances (ADR-049), with rule_version 2, and is
// idempotent through its `ref_key` (unique index points_ledger_auto_uniq), so a
// tick can be repeated safely. Points only for events we can verify: the
// indexer's chain.* tables and the app's own rows.
//
//   registration         50   REGISTRATION      registration
//   first donation      100   FIRST_DONATION    first-donation
//   donation   10·√USDC ≤100   DONATION          donation:<campaign>:<points so far>  (the increase)
//   milestone vote       30   VOTE              vote2:<campaign>:<round>
//   donor via your link  20   REFERRAL          link:<campaign>:<donor user>   (≤ 10 per campaign and referrer)
//   friend joined+gave  100   REFERRAL          friend:<friend user>   (+ 50 to the friend: friend-bonus)
//   supported success    20   CAMPAIGN_SUCCESS  success:<campaign>
//
// Donations to a campaign the user started, or of an organisation they belong
// to, earn nothing (no donation, first-donation, referral or success points).
//
// Watermarks (VOTE-POINTS-WATERMARK, extended): a minute tick looks only at
// votes and donations from the newest seen block minus OVERLAP_BLOCKS (indexes
// on chain.vote/donation.block_number) and at users created in the last
// USERS_OVERLAP_MS. The cursor lives in memory; a restart, and every
// FULL_SWEEP_MS, runs a full pass — it also credits campaign successes (state
// changes carry no block), votes or donations of addresses linked later, and
// rows an indexer rebuild added below the cursor.
//
// Hex columns are compared as they are: chain.* hex columns,
// app.campaigns.onchain_address and app.user_addresses.address are lower-case
// (Ponder; check constraints), and lower() on a column defeats its index (TASK-047).

export const VOTE_POINTS = BigInt(POINTS.vote);
export const OVERLAP_BLOCKS = 2_000n; // ~1 hour of Polygon blocks
export const USERS_OVERLAP_MS = 10 * 60 * 1000;
export const FULL_SWEEP_MS = 6 * 60 * 60 * 1000;

export interface PointsCursor {
  /** Highest chain.vote.block_number seen; null = no pass yet. */
  voteBlock: bigint | null;
  /** Highest chain.donation.block_number seen; null = no pass yet. */
  donationBlock: bigint | null;
  /** Start time (ms) of the last tick: users created after it minus the overlap are new. */
  lastTickAt: number | null;
  /** When the last full pass ran (ms since epoch); null = never. */
  lastFullAt: number | null;
}

export const newPointsCursor = (): PointsCursor => ({ voteBlock: null, donationBlock: null, lastTickAt: null, lastFullAt: null });

export interface PointsResult {
  /** Awards (each counted once, though written to two balances) per rule. */
  awarded: Record<"registration" | "vote" | "donation" | "firstDonation" | "referral" | "friend" | "success", number>;
  full: boolean;
}

const total = (r: PointsResult) => Object.values(r.awarded).reduce((a, b) => a + b, 0);
export const pointsAwarded = total;

const own = (userCol: SQL, campaignAlias: string) => sql`(
  ${sql.raw(campaignAlias)}.starter_user_id = ${userCol}
  or exists (select 1 from app.org_members m where m.org_id = ${sql.raw(campaignAlias)}.org_id and m.user_id = ${userCol})
)`;

/**
 * Inserts the awards `select user_id, reason, delta, ref_type, ref_id, ref_key`
 * into both balances, skipping ref keys already credited. Returns the users
 * that got something.
 */
async function insertAwards(tx: Database, awards: SQL): Promise<string[]> {
  const rows = (await tx.execute(sql`
    with a as (${awards})
    insert into app.points_ledger (id, user_id, bucket, delta, reason, ref_type, ref_id, ref_key, rule_version)
    select gen_random_uuid(), a.user_id, b.bucket::app.point_bucket, a.delta::bigint, a.reason::app.point_reason,
           a.ref_type, a.ref_id, a.ref_key, ${POINTS_RULE_VERSION}
    from a cross join (values ('STATUS'), ('REWARD')) as b(bucket)
    -- Anti-join before the insert (VOTE-POINTS-WATERMARK: ~5× faster than one
    -- speculative insert per row on a full pass); on conflict stays as the guarantee.
    where a.delta::bigint > 0 and not exists (
      select 1 from app.points_ledger l
      where l.user_id = a.user_id and l.reason = a.reason::app.point_reason and l.ref_key = a.ref_key
    )
    on conflict (user_id, reason, bucket, ref_key) where ref_key is not null do nothing
    returning user_id
  `)) as unknown as { user_id: string }[];
  return rows.map((r) => r.user_id);
}

export async function awardPoints(
  db: Database,
  cursor: PointsCursor = newPointsCursor(),
  now: number = Date.now()
): Promise<PointsResult> {
  const full =
    cursor.voteBlock === null || cursor.donationBlock === null || cursor.lastTickAt === null || cursor.lastFullAt === null ||
    now - cursor.lastFullAt >= FULL_SWEEP_MS;
  const from = (block: bigint | null) => (full || block === null ? null : block > OVERLAP_BLOCKS ? block - OVERLAP_BLOCKS : 0n);
  const voteFrom = from(cursor.voteBlock);
  const donationFrom = from(cursor.donationBlock);
  const usersSince = full || cursor.lastTickAt === null ? null : new Date(cursor.lastTickAt - USERS_OVERLAP_MS);

  const result = await db.transaction(async (tx) => {
    const t = tx as unknown as Database;
    // Heads first: rows committed meanwhile have higher blocks and fall into the next range.
    const [heads] = (await tx.execute(sql`
      select (select max(block_number) from chain.vote)::text as vote,
             (select max(block_number) from chain.donation)::text as donation
    `)) as unknown as { vote: string | null; donation: string | null }[];
    const touched = new Set<string>();
    const count = (users: string[]) => {
      users.forEach((u) => touched.add(u));
      return users.length / 2;
    };

    // Registration: real accounts (not demo members, not erased).
    const registration = count(await insertAwards(t, sql`
      select u.id as user_id, 'REGISTRATION' as reason, ${POINTS.registration} as delta, 'user' as ref_type, u.id as ref_id,
             'registration' as ref_key
      from app.users u
      where not u.is_demo and u.privy_did is not null
        ${usersSince ? sql`and u.created_at >= ${usersSince.toISOString()}::timestamptz` : sql``}
    `));

    // Milestone votes: one award per (user, campaign, round), whichever addresses voted.
    const vote = count(await insertAwards(t, sql`
      select distinct ua.user_id, 'VOTE' as reason, ${POINTS.vote} as delta, 'campaign' as ref_type, c.id as ref_id,
             'vote2:' || v.campaign || ':' || v.round as ref_key
      from chain.vote v
      join app.user_addresses ua on ua.address = v.voter
      join app.campaigns c on c.onchain_address = v.campaign
      ${voteFrom !== null ? sql`where v.block_number >= ${voteFrom.toString()}` : sql``}
    `));

    // (user, campaign) pairs with new donations — or all pairs on a full pass —
    // with the user's total to that campaign over all their addresses. Own
    // campaigns are left out here, so nothing below credits them.
    const pairs = sql`
      select fu.user_id, c.id as campaign_id, c.onchain_address as campaign,
             (select sum(cd.donated) from chain.campaign_donor cd
              join app.user_addresses mine on mine.address = cd.donor
              where mine.user_id = fu.user_id and cd.campaign = fu.campaign) as donated
      from (
        select distinct ua.user_id, d.campaign
        from chain.donation d
        join app.user_addresses ua on ua.address = d.donor
        ${donationFrom !== null ? sql`where d.block_number >= ${donationFrom.toString()}` : sql``}
      ) fu
      join app.campaigns c on c.onchain_address = fu.campaign
      where not ${own(sql`fu.user_id`, "c")}
    `;

    // Donation points: target = min(cap, floor(10 × √whole USDC)); credit the
    // increase over what this campaign already earned, keyed by the new target.
    const donation = count(await insertAwards(t, sql`
      select p.user_id, 'DONATION' as reason, p.target - p.earned as delta, 'campaign' as ref_type, p.campaign_id as ref_id,
             'donation:' || p.campaign || ':' || p.target as ref_key
      from (
        select x.user_id, x.campaign_id, x.campaign,
               least(${POINTS.donationCap}, floor(sqrt(100 * floor(x.donated / 1000000))))::int as target,
               coalesce((
                 select sum(l.delta) from app.points_ledger l
                 where l.user_id = x.user_id and l.bucket = 'STATUS' and l.reason = 'DONATION' and l.voided_at is null
                   and l.ref_key like 'donation:' || x.campaign || ':%'
               ), 0)::int as earned
        from (${pairs}) x
      ) p
      where p.target > p.earned
    `));

    // First donation ever.
    const firstDonation = count(await insertAwards(t, sql`
      select distinct x.user_id, 'FIRST_DONATION' as reason, ${POINTS.firstDonation} as delta, 'user' as ref_type,
             x.user_id as ref_id, 'first-donation' as ref_key
      from (${pairs}) x
    `));

    // A donor who came through someone's link to this campaign and gave after
    // that visit; at most N donors per campaign and referrer (earlier visits first).
    const referral = count(await insertAwards(t, sql`
      select r.referrer_user_id as user_id, 'REFERRAL' as reason, ${POINTS.referralDonor} as delta, 'campaign' as ref_type,
             r.campaign_id as ref_id, 'link:' || r.campaign || ':' || r.user_id as ref_key
      from (
        select cr.referrer_user_id, cr.user_id, cr.campaign_id, x.campaign,
               row_number() over (partition by cr.referrer_user_id, cr.campaign_id order by cr.created_at, cr.user_id) as n,
               (select count(*) from app.points_ledger l
                where l.user_id = cr.referrer_user_id and l.bucket = 'STATUS' and l.reason = 'REFERRAL' and l.voided_at is null
                  and l.ref_key like 'link:' || x.campaign || ':%') as already
        from (${pairs}) x
        join app.campaign_referrals cr on cr.user_id = x.user_id and cr.campaign_id = x.campaign_id
        join app.users referrer on referrer.id = cr.referrer_user_id and referrer.privy_did is not null
        where exists (
          select 1 from chain.donation d join app.user_addresses a on a.address = d.donor
          where a.user_id = x.user_id and d.campaign = x.campaign and d.block_time > extract(epoch from cr.created_at)
        )
        and not exists (
          select 1 from app.points_ledger l
          where l.user_id = cr.referrer_user_id and l.reason = 'REFERRAL' and l.ref_key = 'link:' || x.campaign || ':' || cr.user_id
        )
      ) r
      where r.already + r.n <= ${POINTS.referralDonorsPerCampaign}
    `));

    // A friend who joined through the link and then donated: points to both.
    const friendRows = sql`
      select distinct f.id as friend, f.referred_by_user_id as referrer
      from (${pairs}) x
      join app.users f on f.id = x.user_id and f.referred_by_user_id is not null
      join app.users referrer on referrer.id = f.referred_by_user_id and referrer.privy_did is not null
      where exists (
        select 1 from chain.donation d join app.user_addresses a on a.address = d.donor
        where a.user_id = f.id and d.campaign = x.campaign and d.block_time > extract(epoch from f.created_at)
      )
    `;
    const friend = count(await insertAwards(t, sql`
      select fr.referrer as user_id, 'REFERRAL' as reason, ${POINTS.friendReferrer} as delta, 'user' as ref_type,
             fr.friend as ref_id, 'friend:' || fr.friend as ref_key
      from (${friendRows}) fr
      union all
      select fr.friend, 'REFERRAL', ${POINTS.friendBonus}, 'user', fr.referrer, 'friend-bonus'
      from (${friendRows}) fr
    `));

    // A campaign the user supported reached its goal (full pass only: state
    // changes carry no block number to watch).
    const success = full
      ? count(await insertAwards(t, sql`
          select distinct ua.user_id, 'CAMPAIGN_SUCCESS' as reason, ${POINTS.campaignSuccess} as delta, 'campaign' as ref_type,
                 c.id as ref_id, 'success:' || ch.address as ref_key
          from chain.campaign ch
          join chain.campaign_donor cd on cd.campaign = ch.address
          join app.user_addresses ua on ua.address = cd.donor
          join app.campaigns c on c.onchain_address = ch.address
          where ch.state in (${sql.join(SUCCEEDED_CAMPAIGN_STATES.map((s) => sql`${s}`), sql`, `)})
            and not ${own(sql`ua.user_id`, "c")}
        `))
      : 0;

    if (touched.size > 0) {
      // user_levels mirrors the ledger (schema comment): recompute the two balances.
      await tx.execute(sql`
        insert into app.user_levels (user_id, status_points, reward_points, last_activity_at)
        select l.user_id,
               coalesce(sum(l.delta) filter (where l.bucket = 'STATUS'), 0),
               coalesce(sum(l.delta) filter (where l.bucket = 'REWARD'), 0),
               now()
        from app.points_ledger l
        where l.voided_at is null and l.user_id in (${sql.join([...touched].map((u) => sql`${u}::uuid`), sql`, `)})
        group by l.user_id
        on conflict (user_id) do update
          set status_points = excluded.status_points, reward_points = excluded.reward_points,
              last_activity_at = excluded.last_activity_at, updated_at = now()
      `);
    }
    return {
      awarded: { registration, vote, donation, firstDonation, referral, friend, success },
      heads: {
        vote: heads?.vote == null ? null : BigInt(heads.vote),
        donation: heads?.donation == null ? null : BigInt(heads.donation),
      },
    };
  });

  // Advance only after the transaction committed; never move backwards (an
  // indexer rebuild can briefly show fewer rows).
  const advance = (current: bigint | null, head: bigint | null) =>
    head === null ? current ?? 0n : current === null || head > current ? head : current;
  cursor.voteBlock = advance(cursor.voteBlock, result.heads.vote);
  cursor.donationBlock = advance(cursor.donationBlock, result.heads.donation);
  cursor.lastTickAt = now;
  if (full) cursor.lastFullAt = now;
  return { awarded: result.awarded, full };
}

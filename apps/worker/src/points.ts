import { sql } from "drizzle-orm";
import type { Database } from "@cherrio/db";

// Proof of Charity points for votes (TASK-033e, ADR-048, Product Spec §3):
// 200 points per vote, once per (user, campaign, round) — however many of the
// user's addresses voted — credited to both the Status and the Reward balance.
// Source: the indexer's chain.vote (verifiable events only). Idempotent through
// the partial unique index points_ledger_auto_uniq; safe to run every minute.

export const VOTE_POINTS = 200n;

export async function awardVotePoints(db: Database): Promise<number> {
  return db.transaction(async (tx) => {
    const inserted = (await tx.execute(sql`
      with votes as (
        select distinct ua.user_id, c.id as campaign_id, lower(v.campaign) as campaign, v.round
        from chain.vote v
        join app.user_addresses ua on ua.address = lower(v.voter)
        join app.campaigns c on lower(c.onchain_address) = lower(v.campaign)
      )
      insert into app.points_ledger (id, user_id, bucket, delta, reason, ref_type, ref_id, ref_key)
      select gen_random_uuid(), votes.user_id, b.bucket::app.point_bucket, ${VOTE_POINTS.toString()}::bigint, 'VOTE',
             'campaign', votes.campaign_id, 'vote:' || votes.campaign || ':' || votes.round
      from votes cross join (values ('STATUS'), ('REWARD')) as b(bucket)
      on conflict (user_id, reason, bucket, ref_key) where ref_key is not null do nothing
      returning user_id
    `)) as unknown as { user_id: string }[];
    const users = [...new Set(inserted.map((r) => r.user_id))];
    if (users.length > 0) {
      // user_levels mirrors the ledger (schema comment): recompute the two balances.
      await tx.execute(sql`
        insert into app.user_levels (user_id, status_points, reward_points, last_activity_at)
        select l.user_id,
               coalesce(sum(l.delta) filter (where l.bucket = 'STATUS'), 0),
               coalesce(sum(l.delta) filter (where l.bucket = 'REWARD'), 0),
               now()
        from app.points_ledger l
        where l.voided_at is null and l.user_id in (${sql.join(users.map((u) => sql`${u}::uuid`), sql`, `)})
        group by l.user_id
        on conflict (user_id) do update
          set status_points = excluded.status_points, reward_points = excluded.reward_points,
              last_activity_at = excluded.last_activity_at, updated_at = now()
      `);
    }
    return inserted.length / 2;
  });
}

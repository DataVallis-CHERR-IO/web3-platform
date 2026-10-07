import { sql } from "drizzle-orm";
import type { Database } from "@cherrio/db";

// Proof of Charity points for votes (TASK-033e, ADR-048, Product Spec §3):
// 200 points per vote, once per (user, campaign, round) — however many of the
// user's addresses voted — credited to both the Status and the Reward balance (ADR-049).
// Source: the indexer's chain.vote (verifiable events only). Idempotent through
// the partial unique index points_ledger_auto_uniq; safe to run every minute.
//
// Watermark (VOTE-POINTS-WATERMARK): with a cursor, a tick reads only votes from
// `fromBlock` on (the highest block seen minus OVERLAP_BLOCKS), through the
// index on chain.vote.block_number — the cost follows new votes per minute, not
// the size of the vote history. The cursor lives in the worker's memory: a
// restart, and every FULL_SWEEP_MS, runs one full pass. The full pass gives
// points for votes whose address was linked to a user after the vote, and
// covers rows an indexer rebuild added below the watermark. The overlap
// re-reads votes a running indexer cycle may still be committing; the unique
// index makes re-reading harmless.
//
// Hex columns are compared as they are: chain.* hex columns, app.campaigns.onchain_address
// and app.user_addresses.address are lower-case (Ponder; check constraints), and
// lower() on a column defeats its index (TASK-047).

export const VOTE_POINTS = 200n;
export const OVERLAP_BLOCKS = 2_000n; // ~1 hour of Polygon blocks
export const FULL_SWEEP_MS = 6 * 60 * 60 * 1000;

export interface VoteCursor {
  /** Highest chain.vote.block_number seen by the last pass; null = no pass yet. */
  maxBlock: bigint | null;
  /** When the last full pass ran (ms since epoch); null = never. */
  lastFullAt: number | null;
}

export const newVoteCursor = (): VoteCursor => ({ maxBlock: null, lastFullAt: null });

export interface VotePointsResult {
  awarded: number;
  full: boolean;
}

export async function awardVotePoints(
  db: Database,
  cursor: VoteCursor = newVoteCursor(),
  now: number = Date.now()
): Promise<VotePointsResult> {
  const full = cursor.maxBlock === null || cursor.lastFullAt === null || now - cursor.lastFullAt >= FULL_SWEEP_MS;
  const fromBlock = full ? null : cursor.maxBlock! > OVERLAP_BLOCKS ? cursor.maxBlock! - OVERLAP_BLOCKS : 0n;
  const result = await db.transaction(async (tx) => {
    // Read the head before the insert: a vote committed in between has a higher
    // block and lies inside the next tick's range.
    const [head] = (await tx.execute(sql`select max(block_number)::text as max from chain.vote`)) as unknown as {
      max: string | null;
    }[];
    const range = fromBlock === null ? sql`true` : sql`v.block_number >= ${fromBlock.toString()}`;
    const inserted = (await tx.execute(sql`
      with votes as (
        select distinct ua.user_id, c.id as campaign_id, v.campaign, v.round
        from chain.vote v
        join app.user_addresses ua on ua.address = v.voter
        join app.campaigns c on c.onchain_address = v.campaign
        where ${range}
      )
      insert into app.points_ledger (id, user_id, bucket, delta, reason, ref_type, ref_id, ref_key)
      select gen_random_uuid(), votes.user_id, b.bucket::app.point_bucket, ${VOTE_POINTS.toString()}::bigint, 'VOTE',
             'campaign', votes.campaign_id, 'vote:' || votes.campaign || ':' || votes.round
      from votes cross join (values ('STATUS'), ('REWARD')) as b(bucket)
      -- Skip votes already credited before inserting: a hash anti-join instead of
      -- one speculative insert per ledger row (full pass, 1,000,000 awarded votes:
      -- ~13 s → ~2.6 s). Both rows of a vote are written in one statement, so
      -- either one marks it; on conflict stays as the guarantee.
      where not exists (
        select 1 from app.points_ledger l
        where l.user_id = votes.user_id and l.reason = 'VOTE'
          and l.ref_key = 'vote:' || votes.campaign || ':' || votes.round
      )
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
    return { awarded: inserted.length / 2, head: head?.max == null ? null : BigInt(head.max) };
  });
  // Advance only after the transaction committed; never move backwards (an
  // indexer rebuild can briefly show fewer rows).
  if (result.head !== null && (cursor.maxBlock === null || result.head > cursor.maxBlock)) cursor.maxBlock = result.head;
  if (result.head === null && cursor.maxBlock === null) cursor.maxBlock = 0n;
  if (full) cursor.lastFullAt = now;
  return { awarded: result.awarded, full };
}

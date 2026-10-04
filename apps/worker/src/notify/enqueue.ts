import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@cherrio/db";

// Lifecycle email queue (TASK-033e, ADR-045 §5, ADR-048). Reads the indexer's
// chain.* views and inserts one outbox row per (user, kind, event); the unique
// key makes every run idempotent. Only users who can receive email are queued:
// notifications not switched off, and an address — a confirmed contact email
// (wallet-only users, double opt-in) or the login email (Privy).
// A donor is mapped to a user through app.user_addresses (ADR-008: votes and
// refunds belong to the address that donated).

export const RECENT_SECONDS = 2 * 86_400; // vote opened / result: events of the last 2 days
export const REFUND_RECENT_SECONDS = 7 * 86_400;
export const REMINDER_BEFORE_SECONDS = 86_400; // 24 h before the vote closes
export const REMINDER_MIN_WINDOW_SECONDS = 2 * 86_400; // a short (test) window gets no reminder
const REMINDER_MIN_LEFT_SECONDS = 600; // too late to be useful

export interface EnqueueResult {
  voteOpened: number;
  voteReminder: number;
  voteResult: number;
  refundAvailable: number;
}

const recipients = sql`
  select u.id as user_id
  from app.users u
  left join app.notification_preferences p on p.user_id = u.id
  where coalesce(p.email_enabled, true) and coalesce(p.contact_email, u.email) is not null
`;

/** Inserts the rows a select produces: (user_id, kind, dedupe_key, data). */
async function insert(db: Database, rows: SQL): Promise<number> {
  const out = (await db.execute(sql`
    insert into app.notifications (id, user_id, kind, dedupe_key, data)
    select gen_random_uuid(), s.user_id, s.kind::app.notification_kind, s.dedupe_key, s.data
    from (${rows}) s
    on conflict (user_id, kind, dedupe_key) do nothing
    returning id
  `)) as unknown as unknown[];
  return out.length;
}

/** Vote rounds of campaigns the user donated to, with the campaign's page data. */
const roundDonors = sql`
  from chain.vote_round r
  join chain.campaign_donor cd on lower(cd.campaign) = lower(r.campaign) and cd.donated > 0
  join app.user_addresses ua on ua.address = lower(cd.donor)
  join app.campaigns c on lower(c.onchain_address) = lower(r.campaign)
  join (${recipients}) rc on rc.user_id = ua.user_id
`;

export async function enqueueLifecycle(db: Database, now: bigint): Promise<EnqueueResult> {
  const n = now.toString();
  const voteOpened = await insert(db, sql`
    select ua.user_id, 'VOTE_OPENED' as kind, 'vote:' || lower(r.campaign) || ':' || r.round as dedupe_key,
           jsonb_build_object('campaignTitle', c.title, 'slug', c.slug, 'round', r.round, 'voteEnd', r.vote_end::text) as data
    ${roundDonors}
    where r.outcome is null and r.vote_end > ${n}::numeric and r.block_time > ${n}::numeric - ${RECENT_SECONDS}
    group by ua.user_id, r.campaign, r.round, r.vote_end, c.title, c.slug
  `);
  const voteReminder = await insert(db, sql`
    select ua.user_id, 'VOTE_REMINDER' as kind, 'vote:' || lower(r.campaign) || ':' || r.round as dedupe_key,
           jsonb_build_object('campaignTitle', c.title, 'slug', c.slug, 'round', r.round, 'voteEnd', r.vote_end::text) as data
    ${roundDonors}
    where r.outcome is null
      and r.vote_end - ${n}::numeric <= ${REMINDER_BEFORE_SECONDS}
      and r.vote_end - ${n}::numeric > ${REMINDER_MIN_LEFT_SECONDS}
      and r.vote_end - r.block_time > ${REMINDER_MIN_WINDOW_SECONDS}
      and not exists (
        select 1 from chain.vote v
        where lower(v.campaign) = lower(r.campaign) and v.round = r.round and lower(v.voter) = lower(cd.donor)
      )
    group by ua.user_id, r.campaign, r.round, r.vote_end, c.title, c.slug
  `);
  const voteResult = await insert(db, sql`
    select ua.user_id, 'VOTE_RESULT' as kind, 'vote:' || lower(r.campaign) || ':' || r.round as dedupe_key,
           jsonb_build_object('campaignTitle', c.title, 'slug', c.slug, 'round', r.round, 'outcome', r.outcome::text) as data
    ${roundDonors}
    where r.outcome is not null and r.closed_at > ${n}::numeric - ${RECENT_SECONDS}
    group by ua.user_id, r.campaign, r.round, r.outcome, c.title, c.slug
  `);
  const refundAvailable = await insert(db, sql`
    select ua.user_id, 'REFUND_AVAILABLE' as kind, 'refund:' || lower(cc.address) as dedupe_key,
           jsonb_build_object('campaignTitle', c.title, 'slug', c.slug, 'state', cc.state::text,
             'refund', bool_or(cd.preference = 0), 'pool', bool_or(cd.preference = 1)) as data
    from chain.campaign cc
    join chain.campaign_donor cd on lower(cd.campaign) = lower(cc.address) and cd.donated > 0 and not cd.settled
    join app.user_addresses ua on ua.address = lower(cd.donor)
    join app.campaigns c on lower(c.onchain_address) = lower(cc.address)
    join (${recipients}) rc on rc.user_id = ua.user_id
    where cc.state::text in ('FAILED', 'REJECTED') and not cc.swept
      and cc.settlement_start > ${n}::numeric - ${REFUND_RECENT_SECONDS}
    group by ua.user_id, cc.address, cc.state, c.title, c.slug
  `);
  return { voteOpened, voteReminder, voteResult, refundAvailable };
}

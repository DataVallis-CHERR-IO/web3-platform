/**
 * apps/web/src/lib/agents/activity.ts — what the testnet agents did (TASK-061f).
 *
 * Feeds the public testnet page /en/agents. Everything comes from data that
 * already exists — no table written by the runner, no secret:
 * - the crew registry (`@cherrio/shared/agent-crew`: names, roles, public wallets);
 * - `chain.donation` / `chain.pool_contribution` filtered by crew wallets;
 * - `app.campaigns` / `app.kyb_submissions` started by crew users (`users.is_agent`,
 *   linked through `user_addresses` to a crew wallet);
 * - `app.audit_log` rows of crew users for the staff agent's decisions.
 *
 * Only public facts leave this module: counts, USDC amounts, times, transaction
 * hashes, and a campaign's title + slug only while the campaign is public
 * (`DEPLOYED`). Organisation names, notes and audit data are never read.
 */
import { sql, type SQL } from "drizzle-orm";
import type { getDb } from "@/lib/db";
import type { CrewEntry } from "@cherrio/shared/agent-crew";

type Db = ReturnType<typeof getDb>;

/** Staff decisions shown on the page (all three are written by the admin pages). */
export const DECISION_ACTIONS = ["kyb.approve", "campaign.approve", "campaign.publish_sent"] as const;
type DecisionAction = (typeof DECISION_ACTIONS)[number];

export interface Amount { count: number; usdc: bigint }

export interface CrewStats {
  entry: CrewEntry;
  donations: Amount;
  poolGifts: Amount;
  organisationsApplied: number;
  /** Campaigns submitted for review (drafts left out). */
  campaignsStarted: number;
  /** Of those, public on Polygon now. */
  campaignsLive: number;
  organisationsApproved: number;
  campaignsApproved: number;
  campaignsPublished: number;
}

export interface PublicCampaignRef { title: string; slug: string }

export type ActivityItem =
  | { kind: "donation"; at: Date; agent: string; usdc: bigint; tx: string; campaign: PublicCampaignRef | null }
  | { kind: "pool"; at: Date; agent: string; usdc: bigint; tx: string }
  | { kind: "campaign_submitted"; at: Date; agent: string; campaign: PublicCampaignRef | null }
  | { kind: "organisation_applied"; at: Date; agent: string }
  | { kind: "organisation_approved" | "campaign_approved" | "campaign_published"; at: Date; agent: string; campaign: PublicCampaignRef | null };

export interface AgentActivity {
  crew: CrewStats[];
  totals: Omit<CrewStats, "entry">;
  recent: ActivityItem[];
}

const DECISION_KIND: Record<DecisionAction, "organisation_approved" | "campaign_approved" | "campaign_published"> = {
  "kyb.approve": "organisation_approved",
  "campaign.approve": "campaign_approved",
  "campaign.publish_sent": "campaign_published",
};

const list = (values: readonly string[]): SQL => sql.join(values.map((v) => sql`${v}`), sql`, `);
/** The public rule (lib/campaigns/public.ts): a campaign page exists only when DEPLOYED and on chain. */
const ref = (title: string | null, slug: string | null, status: string | null, onchain: string | null): PublicCampaignRef | null =>
  title && slug && status === "DEPLOYED" && onchain ? { title, slug } : null;

/**
 * A staff decision counts only when it was about the crew's own work: a campaign
 * marked demo and started by an agent, or an application submitted by an agent.
 * The server already refuses an agent reviewer anything else (`assertAgentScope`);
 * this keeps a real person's campaign off the public page even if that ever changed.
 */
const CREW_OWNED = sql`(
  (a.entity_type = 'campaign' and exists (
    select 1 from app.campaigns oc join app.users ou on ou.id = oc.starter_user_id
    where oc.id = a.entity_id and oc.is_demo and ou.is_agent))
  or (a.entity_type = 'kyb_submission' and exists (
    select 1 from app.kyb_submissions ok join app.users ou on ou.id = ok.submitted_by
    where ok.id = a.entity_id and ou.is_agent))
)`;
const fromEpoch = (seconds: string) => new Date(Number(seconds) * 1000);

/**
 * Stats per crew member, totals and the `limit` newest things the crew did.
 * `crew` is the registry by default; tests pass their own wallets.
 */
export async function loadAgentActivity(db: Db, crew: readonly CrewEntry[], limit = 20): Promise<AgentActivity> {
  const addresses = crew.map((c) => c.address.toLowerCase());
  const nameByAddress = new Map(crew.map((c) => [c.address.toLowerCase(), c.name]));
  const empty = (entry: CrewEntry): CrewStats => ({
    entry, donations: { count: 0, usdc: 0n }, poolGifts: { count: 0, usdc: 0n },
    organisationsApplied: 0, campaignsStarted: 0, campaignsLive: 0,
    organisationsApproved: 0, campaignsApproved: 0, campaignsPublished: 0,
  });
  const stats = new Map(crew.map((c) => [c.address.toLowerCase(), empty(c)]));
  if (addresses.length === 0) return { crew: [], totals: sumStats([]), recent: [] };

  // Crew users: only users the login marked as agents (061c), linked to a crew wallet.
  const users = (await db.execute(sql`
    select u.id::text as id, ua.address
    from app.users u join app.user_addresses ua on ua.user_id = u.id
    where u.is_agent and ua.address in (${list(addresses)})
  `)) as unknown as { id: string; address: string }[];
  const addressByUser = new Map(users.map((u) => [u.id, u.address]));
  const userIds = [...addressByUser.keys()];

  const [donations, gifts] = await Promise.all([
    db.execute(sql`
      select donor, count(*)::int as n, coalesce(sum(amount), 0)::text as total
      from chain.donation where donor in (${list(addresses)}) group by donor
    `) as unknown as Promise<{ donor: string; n: number; total: string }[]>,
    db.execute(sql`
      select donor, count(*)::int as n, coalesce(sum(amount), 0)::text as total
      from chain.pool_contribution where source = 'DIRECT' and donor in (${list(addresses)}) group by donor
    `) as unknown as Promise<{ donor: string; n: number; total: string }[]>,
  ]);
  for (const r of donations) { const s = stats.get(r.donor); if (s) s.donations = { count: r.n, usdc: BigInt(r.total) }; }
  for (const r of gifts) { const s = stats.get(r.donor); if (s) s.poolGifts = { count: r.n, usdc: BigInt(r.total) }; }

  const recent: ActivityItem[] = [];
  const [donationRows, giftRows] = await Promise.all([
    db.execute(sql`
      select d.donor, d.amount::text as amount, d.tx_hash, d.block_time::text as block_time, c.title, c.slug, c.status, c.onchain_address
      from chain.donation d left join app.campaigns c on c.onchain_address = d.campaign
      where d.donor in (${list(addresses)})
      order by d.block_number desc, d.log_index desc limit ${limit}
    `) as unknown as Promise<{ donor: string; amount: string; tx_hash: string; block_time: string; title: string | null; slug: string | null; status: string | null; onchain_address: string | null }[]>,
    db.execute(sql`
      select donor, amount::text as amount, tx_hash, block_time::text as block_time
      from chain.pool_contribution where source = 'DIRECT' and donor in (${list(addresses)})
      order by block_number desc, log_index desc limit ${limit}
    `) as unknown as Promise<{ donor: string; amount: string; tx_hash: string; block_time: string }[]>,
  ]);
  for (const r of donationRows) {
    recent.push({ kind: "donation", at: fromEpoch(r.block_time), agent: nameByAddress.get(r.donor)!, usdc: BigInt(r.amount), tx: r.tx_hash, campaign: ref(r.title, r.slug, r.status, r.onchain_address) });
  }
  for (const r of giftRows) {
    recent.push({ kind: "pool", at: fromEpoch(r.block_time), agent: nameByAddress.get(r.donor)!, usdc: BigInt(r.amount), tx: r.tx_hash });
  }

  if (userIds.length > 0) {
    const [campaignCounts, kybCounts, decisionCounts, campaignRows, kybRows, decisionRows] = await Promise.all([
      db.execute(sql`
        select starter_user_id::text as user_id,
               count(*) filter (where submitted_at is not null)::int as started,
               count(*) filter (where status = 'DEPLOYED' and onchain_address is not null)::int as live
        from app.campaigns where starter_user_id in (${list(userIds)}) group by starter_user_id
      `) as unknown as Promise<{ user_id: string; started: number; live: number }[]>,
      db.execute(sql`
        select submitted_by::text as user_id, count(*)::int as n
        from app.kyb_submissions where submitted_by in (${list(userIds)}) group by submitted_by
      `) as unknown as Promise<{ user_id: string; n: number }[]>,
      db.execute(sql`
        select actor_user_id::text as user_id, action, count(*)::int as n
        from app.audit_log a where a.actor_user_id in (${list(userIds)}) and a.action in (${list(DECISION_ACTIONS)}) and ${CREW_OWNED}
        group by actor_user_id, action
      `) as unknown as Promise<{ user_id: string; action: DecisionAction; n: number }[]>,
      db.execute(sql`
        select starter_user_id::text as user_id, title, slug, status::text as status, onchain_address, submitted_at
        from app.campaigns where starter_user_id in (${list(userIds)}) and submitted_at is not null
        order by submitted_at desc limit ${limit}
      `) as unknown as Promise<{ user_id: string; title: string; slug: string; status: string; onchain_address: string | null; submitted_at: string | Date }[]>,
      db.execute(sql`
        select submitted_by::text as user_id, created_at
        from app.kyb_submissions where submitted_by in (${list(userIds)})
        order by created_at desc limit ${limit}
      `) as unknown as Promise<{ user_id: string; created_at: string | Date }[]>,
      db.execute(sql`
        select a.actor_user_id::text as user_id, a.action, a.created_at, c.title, c.slug, c.status::text as status, c.onchain_address
        from app.audit_log a
        left join app.campaigns c on a.entity_type = 'campaign' and c.id = a.entity_id
        where a.actor_user_id in (${list(userIds)}) and a.action in (${list(DECISION_ACTIONS)}) and ${CREW_OWNED}
        order by a.created_at desc limit ${limit}
      `) as unknown as Promise<{ user_id: string; action: DecisionAction; created_at: string | Date; title: string | null; slug: string | null; status: string | null; onchain_address: string | null }[]>,
    ]);
    const statsOf = (userId: string) => stats.get(addressByUser.get(userId) ?? "");
    const agentOf = (userId: string) => nameByAddress.get(addressByUser.get(userId) ?? "")!;
    for (const r of campaignCounts) { const s = statsOf(r.user_id); if (s) { s.campaignsStarted += r.started; s.campaignsLive += r.live; } }
    for (const r of kybCounts) { const s = statsOf(r.user_id); if (s) s.organisationsApplied += r.n; }
    for (const r of decisionCounts) {
      const s = statsOf(r.user_id);
      if (!s) continue;
      if (r.action === "kyb.approve") s.organisationsApproved += r.n;
      else if (r.action === "campaign.approve") s.campaignsApproved += r.n;
      else s.campaignsPublished += r.n;
    }
    for (const r of campaignRows) recent.push({ kind: "campaign_submitted", at: new Date(r.submitted_at), agent: agentOf(r.user_id), campaign: ref(r.title, r.slug, r.status, r.onchain_address) });
    for (const r of kybRows) recent.push({ kind: "organisation_applied", at: new Date(r.created_at), agent: agentOf(r.user_id) });
    for (const r of decisionRows) {
      recent.push({ kind: DECISION_KIND[r.action], at: new Date(r.created_at), agent: agentOf(r.user_id), campaign: ref(r.title, r.slug, r.status, r.onchain_address) });
    }
  }

  recent.sort((a, b) => b.at.getTime() - a.at.getTime());
  const crewStats = crew.map((c) => stats.get(c.address.toLowerCase())!);
  return { crew: crewStats, totals: sumStats(crewStats), recent: recent.slice(0, limit) };
}

function sumStats(rows: readonly CrewStats[]): Omit<CrewStats, "entry"> {
  const t: Omit<CrewStats, "entry"> = {
    donations: { count: 0, usdc: 0n }, poolGifts: { count: 0, usdc: 0n },
    organisationsApplied: 0, campaignsStarted: 0, campaignsLive: 0,
    organisationsApproved: 0, campaignsApproved: 0, campaignsPublished: 0,
  };
  for (const r of rows) {
    t.donations = { count: t.donations.count + r.donations.count, usdc: t.donations.usdc + r.donations.usdc };
    t.poolGifts = { count: t.poolGifts.count + r.poolGifts.count, usdc: t.poolGifts.usdc + r.poolGifts.usdc };
    t.organisationsApplied += r.organisationsApplied;
    t.campaignsStarted += r.campaignsStarted;
    t.campaignsLive += r.campaignsLive;
    t.organisationsApproved += r.organisationsApproved;
    t.campaignsApproved += r.campaignsApproved;
    t.campaignsPublished += r.campaignsPublished;
  }
  return t;
}

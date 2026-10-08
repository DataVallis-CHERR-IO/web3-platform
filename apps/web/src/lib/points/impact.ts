import { sql } from "drizzle-orm";
import type { Database } from "@cherrio/db";
import { LEVELS, POINTS_RULE_VERSION, levelFor, type LevelProgress, type LevelRule } from "@cherrio/shared/points";

// "My impact" (TASK-056b, ADR-057 §6): the user's level, the next step and what
// they did — read from the points ledger only, so it always matches the points
// the worker credited (and works while the indexer is rebuilding).

export interface ImpactEntry {
  reason: string;
  delta: number;
  createdAt: Date;
  campaignTitle: string | null;
  campaignSlug: string | null;
}

export interface Impact extends LevelProgress {
  rewardPoints: number;
  campaignsSucceeded: number;
  level: number;
  /** The level after this one, or null at the top. */
  next: LevelRule | null;
  /** What is still missing for `next` (empty when only time is needed). */
  missing: Missing[];
  recent: ImpactEntry[];
}

export type Missing =
  | { kind: "points"; count: number }
  | { kind: "campaigns"; count: number }
  | { kind: "vote" }
  | { kind: "rating" }
  | { kind: "people"; count: number }
  | { kind: "months"; count: number };

/** What `p` still needs for `rule` (points first, then the action). */
export function missingFor(rule: LevelRule, p: LevelProgress): Missing[] {
  const out: Missing[] = [];
  if (p.statusPoints < rule.points) out.push({ kind: "points", count: rule.points - p.statusPoints });
  if (rule.key === "giver" && p.campaignsSupported < 3) out.push({ kind: "campaigns", count: 3 - p.campaignsSupported });
  if (rule.key === "guardian") {
    if (p.votes < 1) out.push({ kind: "vote" });
    if (p.ratings < 1) out.push({ kind: "rating" });
  }
  if (rule.key === "ambassador" && p.peopleBrought < 3) out.push({ kind: "people", count: 3 - p.peopleBrought });
  if (rule.key === "champion" && p.activeMonths < 6) out.push({ kind: "months", count: 6 - p.activeMonths });
  return out;
}

export async function getImpact(db: Database, userId: string, recentLimit = 10): Promise<Impact> {
  const [row] = (await db.execute(sql`
    select
      coalesce(sum(delta) filter (where bucket = 'STATUS'), 0)::int as status,
      coalesce(sum(delta) filter (where bucket = 'REWARD'), 0)::int as reward,
      count(distinct split_part(ref_key, ':', 2)) filter (where bucket = 'STATUS' and reason = 'DONATION' and rule_version = ${POINTS_RULE_VERSION})::int as campaigns,
      count(*) filter (where bucket = 'STATUS' and reason = 'VOTE' and rule_version = ${POINTS_RULE_VERSION})::int as votes,
      count(*) filter (where bucket = 'STATUS' and reason = 'RATING')::int as ratings,
      count(*) filter (where bucket = 'STATUS' and reason = 'CAMPAIGN_SUCCESS')::int as succeeded,
      count(distinct case
        when reason = 'REFERRAL' and ref_key like 'link:%' then split_part(ref_key, ':', 3)
        when reason = 'REFERRAL' and ref_key like 'friend:%' then split_part(ref_key, ':', 2)
      end) filter (where bucket = 'STATUS')::int as people,
      count(distinct date_trunc('month', created_at)) filter (where bucket = 'STATUS')::int as months
    from app.points_ledger
    where user_id = ${userId} and voided_at is null
  `)) as unknown as {
    status: number; reward: number; campaigns: number; votes: number; ratings: number; succeeded: number; people: number; months: number;
  }[];
  const progress: LevelProgress = {
    statusPoints: Number(row?.status ?? 0),
    campaignsSupported: Number(row?.campaigns ?? 0),
    votes: Number(row?.votes ?? 0),
    ratings: Number(row?.ratings ?? 0),
    peopleBrought: Number(row?.people ?? 0),
    activeMonths: Number(row?.months ?? 0),
  };
  const level = levelFor(progress);
  const next = LEVELS.find((l) => l.level === level + 1) ?? null;

  const recent = (await db.execute(sql`
    select l.reason, l.delta::int as delta, l.created_at, c.title, c.slug
    from app.points_ledger l
    left join app.campaigns c on l.ref_type = 'campaign' and c.id = l.ref_id and c.status = 'DEPLOYED'
    where l.user_id = ${userId} and l.bucket = 'STATUS' and l.voided_at is null
    order by l.created_at desc, l.id
    limit ${recentLimit}
  `)) as unknown as { reason: string; delta: number; created_at: Date | string; title: string | null; slug: string | null }[];

  return {
    ...progress,
    rewardPoints: Number(row?.reward ?? 0),
    campaignsSucceeded: Number(row?.succeeded ?? 0),
    level,
    next,
    missing: next ? missingFor(next, progress) : [],
    recent: recent.map((r) => ({
      reason: r.reason,
      delta: Number(r.delta),
      createdAt: new Date(r.created_at),
      campaignTitle: r.title,
      campaignSlug: r.slug,
    })),
  };
}

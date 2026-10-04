import { and, avg, count, desc, eq, like, lt, ne, sql } from "drizzle-orm";
import { auditLog, campaigns, ratings, users, type Database } from "@cherrio/db";
import { isMissingRelation } from "@/lib/campaigns/publish";
import { loadLifecycle, type CampaignLifecycle, type ChainState } from "@/lib/campaigns/lifecycle";
import { CampaignReviewRefusedError } from "@/lib/campaigns/review";

// Admin chain actions (TASK-033d): the operator sets a succeeded campaign's
// payout mode; the Guardian decides a vote that ended in NEEDS_REVIEW
// (`resolve`), freezes a campaign, or unfreezes it (`resolve(true)` on FROZEN).
// The admin signs in their own wallet (ADR-035); this module only says which
// action is open in the indexed state, suggests a payout mode, and writes the
// admin's note and the transaction to audit_log. The contract stays the judge:
// the rules here mirror Campaign.sol so the page shows the right buttons.
//
// Manual fallback (TASK-033f, ADR-050): when nobody finalizes a campaign or
// counts a vote for 7 days, or the refund window of a failed/rejected campaign
// is over, the campaign appears in the admin queue and an admin sends the call
// from their own wallet. No server key: the worker holds none (ADR-048/050).

export const FALLBACK_ACTIONS = ["finalize", "closeVote", "sweepUnclaimed"] as const;
export type FallbackAction = (typeof FALLBACK_ACTIONS)[number];
export const CHAIN_ACTIONS = ["setPayoutMode", "resolve", "freeze", ...FALLBACK_ACTIONS] as const;
export type ChainAction = (typeof CHAIN_ACTIONS)[number];

/** ADR-045 §4 / ADR-050: CHERR.IO steps in when nobody acted for 7 days. */
export const FALLBACK_IDLE_SECONDS = 7n * 86_400n;

export const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000));

type FallbackFields = Pick<CampaignLifecycle, "state" | "deadline" | "voteEnd" | "settlementStart" | "swept" | "snapshot">;

/**
 * Which fallback calls are due (Campaign.sol finalize / closeVote /
 * sweepUnclaimed, all callable by anyone): finalize 7 days after the deadline,
 * closeVote 7 days after the vote end, sweepUnclaimed once the campaign's own
 * refund window (`snap_refund_sweep_delay` after `settlementStart`) is over.
 * An unknown snapshot (indexer without the column) never makes a sweep due.
 */
export function dueFallbacks(lc: FallbackFields, now: bigint): Record<FallbackAction, boolean> {
  const delay = lc.snapshot.refundSweepDelay;
  return {
    finalize: lc.state === "LIVE" && now >= lc.deadline + FALLBACK_IDLE_SECONDS,
    closeVote: lc.state === "VOTING" && now >= lc.voteEnd + FALLBACK_IDLE_SECONDS,
    sweepUnclaimed:
      (lc.state === "FAILED" || lc.state === "REJECTED") && !lc.swept && delay !== null && now >= lc.settlementStart + BigInt(delay),
  };
}

/** Campaign.freeze(): states a Guardian can freeze. */
const FREEZABLE: readonly ChainState[] = ["LIVE", "SUCCEEDED", "PAYING", "VOTING", "NEEDS_REVIEW"];

/** Which admin chain actions the indexed state allows (Campaign.sol setPayoutMode / resolve / freeze + the due fallbacks). */
export function openChainActions(lc: FallbackFields & Pick<CampaignLifecycle, "payoutMode">, now: bigint): Record<ChainAction, boolean> {
  return {
    setPayoutMode: lc.state === "SUCCEEDED" && lc.payoutMode === null,
    resolve: lc.state === "NEEDS_REVIEW" || lc.state === "FROZEN",
    freeze: FREEZABLE.includes(lc.state),
    ...dueFallbacks(lc, now),
  };
}

export type PayoutReason = "individual" | "first_campaign" | "rating_high" | "rating_low" | "no_rating";

export interface PayoutSuggestion {
  /** 0 = SINGLE, 1 = MILESTONES. */
  mode: 0 | 1;
  reason: PayoutReason;
  /** Average stars of the organisation (1–5), null without ratings. */
  rating: number | null;
}

/**
 * Product Spec §2.4 + TASK-033 §033d: an individual is always paid in
 * milestones (the contract refuses SINGLE); an organisation's first campaign is
 * paid at once under supervision; later, rating ≥ 4.0 → SINGLE, below →
 * MILESTONES. Not first and no rating yet → MILESTONES (David, ADR-049).
 * Only a suggestion: the admin chooses.
 */
export function suggestPayoutMode(input: { individual: boolean; earlierCampaigns: number; rating: number | null }): PayoutSuggestion {
  const { rating } = input;
  if (input.individual) return { mode: 1, reason: "individual", rating };
  if (input.earlierCampaigns === 0) return { mode: 0, reason: "first_campaign", rating };
  if (rating === null) return { mode: 1, reason: "no_rating", rating };
  return rating >= 4 ? { mode: 0, reason: "rating_high", rating } : { mode: 1, reason: "rating_low", rating };
}

export async function loadPayoutSuggestion(db: Database, campaignId: string): Promise<PayoutSuggestion | null> {
  const [c] = await db
    .select({ orgId: campaigns.orgId, type: campaigns.beneficiaryType, deployedAt: campaigns.deployedAt })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  if (!c) return null;
  if (c.type === "INDIVIDUAL" || !c.orgId) return suggestPayoutMode({ individual: true, earlierCampaigns: 0, rating: null });
  const [earlier] = await db
    .select({ n: count() })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.orgId, c.orgId),
        eq(campaigns.status, "DEPLOYED"),
        ne(campaigns.id, campaignId),
        c.deployedAt ? lt(campaigns.deployedAt, c.deployedAt) : undefined
      )
    );
  const [stars] = await db.select({ avg: avg(ratings.stars), n: count() }).from(ratings).where(eq(ratings.orgId, c.orgId));
  const rating = stars && stars.n > 0 && stars.avg !== null ? Math.round(Number(stars.avg) * 10) / 10 : null;
  return suggestPayoutMode({ individual: false, earlierCampaigns: earlier?.n ?? 0, rating });
}

export interface GuardianQueueRow {
  id: string;
  title: string;
  organization: string | null;
  address: string;
  state: ChainState;
  /** What the admin is asked to do. */
  task: GuardianTask;
}

export type GuardianTask = "payout_mode" | "review" | "frozen" | "finalize_overdue" | "close_vote_overdue" | "sweep_due";

const TASK_OF: Record<ChainState, GuardianTask | null> = {
  SUCCEEDED: "payout_mode", NEEDS_REVIEW: "review", FROZEN: "frozen", LIVE: "finalize_overdue", VOTING: "close_vote_overdue",
  FAILED: "sweep_due", REJECTED: "sweep_due", PAYING: null, COMPLETED: null,
};

/**
 * Deployed campaigns waiting for an admin chain action, oldest task first:
 * SUCCEEDED without a payout mode, NEEDS_REVIEW, FROZEN, and the due manual
 * fallbacks (same rules as `dueFallbacks`). null = the indexer's views are not
 * there (a deploy in progress).
 */
export async function loadGuardianQueue(db: Database, now: bigint = nowSeconds()): Promise<GuardianQueueRow[] | null> {
  const idle = FALLBACK_IDLE_SECONDS;
  try {
    const rows = (await db.execute(sql`
      select * from (
        select c.id, c.title, o.name as organization, lower(cc.address) as address, cc.state::text as state,
          case
            when cc.state::text = 'LIVE' then cc.deadline::numeric + ${idle.toString()}::numeric
            when cc.state::text = 'VOTING' then cc.vote_end::numeric + ${idle.toString()}::numeric
            when cc.state::text in ('FAILED', 'REJECTED') then cc.settlement_start::numeric + (to_jsonb(cc)->>'snap_refund_sweep_delay')::numeric
            else cc.end_time::numeric
          end as due_at
        from chain.campaign cc
        join app.campaigns c on lower(c.onchain_address) = lower(cc.address)
        left join app.organizations o on o.id = c.org_id
        where (cc.state::text = 'SUCCEEDED' and cc.payout_mode is null)
          or cc.state::text in ('NEEDS_REVIEW', 'FROZEN', 'LIVE', 'VOTING')
          or (cc.state::text in ('FAILED', 'REJECTED') and not cc.swept)
      ) q
      where q.state not in ('LIVE', 'VOTING', 'FAILED', 'REJECTED') or q.due_at <= ${now.toString()}::numeric
      order by q.due_at asc, q.id asc
      limit 200
    `)) as unknown as { id: string; title: string; organization: string | null; address: string; state: ChainState }[];
    return rows.map(({ id, title, organization, address, state }) => ({
      id, title, organization, address, state, task: TASK_OF[state] ?? "review",
    }));
  } catch (e) {
    if (isMissingRelation(e)) return null;
    throw e;
  }
}

export const NOTE_MIN = 10;
export const NOTE_MAX = 2000;

export type ChainActionInput =
  | { action: "setPayoutMode"; mode: 0 | 1; note?: string }
  | { action: "resolve"; approve: boolean; note: string }
  | { action: "freeze"; note: string }
  | { action: FallbackAction; note?: string };

/** Notes are required for the Guardian's decisions, optional for the payout mode and the fallbacks. */
export function noteRequired(action: ChainAction): boolean {
  return action === "resolve" || action === "freeze";
}

async function deployedCampaign(db: Database, campaignId: string) {
  const [c] = await db
    .select({ status: campaigns.status, address: campaigns.onchainAddress, type: campaigns.beneficiaryType })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  if (!c) throw new CampaignReviewRefusedError("not_found");
  if (c.status !== "DEPLOYED" || !c.address) throw new CampaignReviewRefusedError("not_deployed");
  return { address: c.address.toLowerCase(), individual: c.type === "INDIVIDUAL" };
}

/**
 * Step 1, before the wallet opens: checks the action against the indexed
 * state and writes the admin's intent and note (`chain.<action>.requested`).
 * The note is kept even if the admin then cancels in the wallet.
 */
export async function recordChainIntent(db: Database, adminId: string, campaignId: string, input: ChainActionInput, ip?: string) {
  const c = await deployedCampaign(db, campaignId);
  let lc: CampaignLifecycle | null;
  try {
    lc = await loadLifecycle(db, c.address);
  } catch (e) {
    if (isMissingRelation(e)) throw new CampaignReviewRefusedError("chain_unavailable");
    throw e;
  }
  if (!lc) throw new CampaignReviewRefusedError("chain_unavailable");
  if (!openChainActions(lc, nowSeconds())[input.action]) throw new CampaignReviewRefusedError("wrong_state");
  if (input.action === "setPayoutMode" && input.mode === 0 && c.individual) throw new CampaignReviewRefusedError("wrong_state");
  const [row] = await db
    .insert(auditLog)
    .values({
      actorUserId: adminId,
      action: `chain.${input.action}.requested`,
      entityType: "campaign",
      entityId: campaignId,
      data: { ...input, campaign: c.address, state: lc.state, round: lc.currentRound },
      ip,
    })
    .returning({ id: auditLog.id });
  return { requestId: row!.id };
}

/**
 * Step 2, after the wallet returned a hash: links the transaction to the
 * request. Not re-checked against the state: the indexer may not have seen
 * the transaction yet, and the chain is the record of what happened.
 */
export async function recordChainSent(
  db: Database, adminId: string, campaignId: string, input: { requestId: string; txHash: string }, ip?: string
) {
  await deployedCampaign(db, campaignId);
  const [request] = await db
    .select({ action: auditLog.action, data: auditLog.data })
    .from(auditLog)
    .where(and(eq(auditLog.id, input.requestId), eq(auditLog.entityId, campaignId), like(auditLog.action, "chain.%.requested")));
  if (!request) throw new CampaignReviewRefusedError("not_found");
  const action = request.action.replace(/\.requested$/, ".sent");
  await db.insert(auditLog).values({
    actorUserId: adminId, action, entityType: "campaign", entityId: campaignId,
    data: { requestId: input.requestId, txHash: input.txHash.toLowerCase() }, ip,
  });
  return { ok: true };
}

export interface ChainActionLogEntry {
  id: string;
  action: ChainAction;
  phase: "requested" | "sent";
  actor: string | null;
  at: string;
  note: string | null;
  /** setPayoutMode: 0/1; resolve: approve true/false. */
  mode: 0 | 1 | null;
  approve: boolean | null;
  txHash: string | null;
  requestId: string | null;
}

/** The campaign's admin chain actions, newest first: notes and transactions. */
export async function listChainActionLog(db: Database, campaignId: string, limit = 50): Promise<ChainActionLogEntry[]> {
  const rows = await db
    .select({ id: auditLog.id, action: auditLog.action, data: auditLog.data, at: auditLog.createdAt, actor: users.displayName })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(and(eq(auditLog.entityType, "campaign"), eq(auditLog.entityId, campaignId), like(auditLog.action, "chain.%")))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit);
  return rows.flatMap((r) => {
    const [, action, phase] = r.action.split(".");
    if (!CHAIN_ACTIONS.includes(action as ChainAction) || (phase !== "requested" && phase !== "sent")) return [];
    const d = (r.data ?? {}) as Record<string, unknown>;
    return [{
      id: r.id,
      action: action as ChainAction,
      phase,
      actor: r.actor,
      at: r.at.toISOString(),
      note: typeof d.note === "string" && d.note ? d.note : null,
      mode: d.mode === 0 || d.mode === 1 ? d.mode : null,
      approve: typeof d.approve === "boolean" ? d.approve : null,
      txHash: typeof d.txHash === "string" ? d.txHash : null,
      requestId: typeof d.requestId === "string" ? d.requestId : null,
    }];
  });
}

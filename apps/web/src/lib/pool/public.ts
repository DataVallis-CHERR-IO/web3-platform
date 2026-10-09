import { sql } from "drizzle-orm";
import type { Database } from "@cherrio/db";
import { isMissingRelation } from "@/lib/campaigns/publish";

// Public Emergency Pool page (TASK-014a): sub-pool balances and allocation votes,
// read from the indexer's `chain.*` views (ADR-026). Read-only.

const BPS = 10_000n;

/** The views are missing (a deploy) or still the previous schema without a new column. */
const viewsUnavailable = (e: unknown) => {
  if (isMissingRelation(e)) return true;
  const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
  return code === "42703";
};

export interface PoolCard {
  poolId: number;
  slug: string;
  /** USDC base units available now (reserved amounts of open votes are not included). */
  balance: bigint;
  /** Everything ever given with voting weight (direct gifts + donors' failed-campaign money). */
  contributed: bigint;
  contributors: number;
}

/** Sub-pools that exist on chain, in pool order; null while the indexer views are missing. */
export async function loadPoolCards(db: Database): Promise<PoolCard[] | null> {
  try {
    const rows = (await db.execute(sql`
      select s.pool_id, s.slug, p.balance::text as balance, p.total_contributed::text as contributed,
        (select count(distinct pc.donor) from chain.pool_contribution pc where pc.pool_id = s.pool_id)::int as contributors
      from app.emergency_subpools s
      join chain.pool p on p.id = s.pool_id
      order by s.pool_id
    `)) as unknown as { pool_id: number; slug: string; balance: string; contributed: string; contributors: number }[];
    return rows.map((r) => ({
      poolId: Number(r.pool_id),
      slug: r.slug,
      balance: BigInt(r.balance),
      contributed: BigInt(r.contributed),
      contributors: Number(r.contributors),
    }));
  } catch (e) {
    if (!viewsUnavailable(e)) throw e;
    return null;
  }
}

export const ALLOCATION_STATES = [
  "VOTING",
  "PASSED",
  "REJECTED",
  "NEEDS_REVIEW",
  "RESOLVED_PASS",
  "RESOLVED_REJECT",
  "DELIVERY_FAILED",
] as const;
export type AllocationState = (typeof ALLOCATION_STATES)[number];

export interface AllocationRow {
  id: string;
  poolId: number;
  poolSlug: string | null;
  campaignAddress: string;
  campaignTitle: string | null;
  campaignSlug: string | null;
  amount: bigint;
  /** What reached the campaign (can be less than the amount when the campaign needed less); null until sent. */
  delivered: bigint | null;
  yes: bigint;
  no: bigint;
  /** Voting weight that existed before the proposal (contributions credited before its block). */
  eligible: bigint;
  voteEnd: Date;
  quorumBps: number;
  approvalBps: number;
  state: AllocationState;
}

/** The newest allocations (most recent proposal first); null while the indexer views are missing. */
export async function loadAllocations(db: Database, limit = 20): Promise<AllocationRow[] | null> {
  try {
    const rows = (await db.execute(sql`
      select a.id::text as id, a.pool_id, s.slug as pool_slug, a.campaign, c.title, c.slug,
        a.amount::text as amount, a.delivered::text as delivered,
        a.yes_votes::text as yes, a.no_votes::text as no, a.vote_end::text as vote_end,
        a.snap_quorum_bps, a.snap_approval_bps, a.state::text as state,
        (select coalesce(sum(pc.amount), 0) from chain.pool_contribution pc
          where pc.pool_id = a.pool_id and pc.block_number < a.proposal_block)::text as eligible
      from chain.allocation a
      left join app.emergency_subpools s on s.pool_id = a.pool_id
      left join app.campaigns c on c.onchain_address = a.campaign
      order by a.id desc
      limit ${limit}
    `)) as unknown as {
      id: string; pool_id: number; pool_slug: string | null; campaign: string; title: string | null; slug: string | null;
      amount: string; delivered: string | null; yes: string; no: string; vote_end: string;
      snap_quorum_bps: number; snap_approval_bps: number; state: string; eligible: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      poolId: Number(r.pool_id),
      poolSlug: r.pool_slug,
      campaignAddress: r.campaign,
      campaignTitle: r.title,
      campaignSlug: r.slug,
      amount: BigInt(r.amount),
      delivered: r.delivered === null ? null : BigInt(r.delivered),
      yes: BigInt(r.yes),
      no: BigInt(r.no),
      eligible: BigInt(r.eligible),
      voteEnd: new Date(Number(r.vote_end) * 1000),
      quorumBps: Number(r.snap_quorum_bps),
      approvalBps: Number(r.snap_approval_bps),
      state: (ALLOCATION_STATES as readonly string[]).includes(r.state) ? (r.state as AllocationState) : "VOTING",
    }));
  } catch (e) {
    if (!viewsUnavailable(e)) throw e;
    return null;
  }
}

export interface VoteFigures {
  /** Share of the eligible weight that voted, in basis points (0 when nobody could vote). */
  turnoutBps: number;
  /** Share of yes among the cast weight, in basis points (null before the first vote). */
  approvalBps: number | null;
  quorumReached: boolean;
  approvalReached: boolean;
}

/** The same arithmetic as EmergencyPool.closeAllocation (integer, rounding down). */
export function voteFigures(a: Pick<AllocationRow, "yes" | "no" | "eligible" | "quorumBps" | "approvalBps">): VoteFigures {
  const cast = a.yes + a.no;
  return {
    turnoutBps: a.eligible > 0n ? Number((cast * BPS) / a.eligible) : 0,
    approvalBps: cast > 0n ? Number((a.yes * BPS) / cast) : null,
    quorumReached: a.eligible > 0n && cast * BPS >= a.eligible * BigInt(a.quorumBps),
    approvalReached: cast > 0n && a.yes * BPS >= cast * BigInt(a.approvalBps),
  };
}

/** What a visitor reads for the state; an open vote past its end waits to be counted. */
export type AllocationPhase =
  | "open"
  | "counting"
  | "sent"
  | "notApproved"
  | "review"
  | "sentByCherrio"
  | "returnedByCherrio"
  | "notSent";

export function allocationPhase(state: AllocationState, voteEnd: Date, now = new Date()): AllocationPhase {
  switch (state) {
    case "VOTING":
      return now.getTime() >= voteEnd.getTime() ? "counting" : "open";
    case "PASSED":
      return "sent";
    case "REJECTED":
      return "notApproved";
    case "NEEDS_REVIEW":
      return "review";
    case "RESOLVED_PASS":
      return "sentByCherrio";
    case "RESOLVED_REJECT":
      return "returnedByCherrio";
    case "DELIVERY_FAILED":
      return "notSent";
  }
}

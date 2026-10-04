import { sql } from "drizzle-orm";
import type { Database } from "@cherrio/db";
import { isMissingRelation } from "./publish";

// TASK-033b: what happens to a campaign after it goes live — finalize, payout,
// evidence, vote, refund or Emergency Pool — read from the indexer's `chain.*`
// views (ADR-026). The rules below mirror Campaign.sol exactly (finalize,
// release, vote, closeVote, claimRefund, settleToPool); the contract stays the
// judge, this only decides which buttons to show and with which amounts.
// Pure functions first (unit-tested without a database), then the loaders.

export const CHAIN_STATES = [
  "LIVE", "SUCCEEDED", "FAILED", "PAYING", "COMPLETED", "VOTING", "NEEDS_REVIEW", "REJECTED", "FROZEN",
] as const;
export type ChainState = (typeof CHAIN_STATES)[number];

const BPS = 10_000n;

/**
 * The campaign's own copy of PlatformConfig, taken when it was created
 * (indexed `snap_*` columns). null = not known (an indexer view without the
 * columns, during a deploy) — never replaced by today's config.
 */
export interface Snapshot {
  voteWindow: number | null;
  quorumBps: number | null;
  approvalBps: number | null;
  releaseDelay: number | null;
  refundSweepDelay: number | null;
}

export interface VoteRound {
  round: number;
  bundleHash: string;
  voteEnd: bigint;
  yes: bigint;
  no: bigint;
  outcome: ChainState | null;
  closedAt: bigint | null;
}

export interface CampaignLifecycle {
  address: string;
  state: ChainState;
  deadline: bigint;
  endTime: bigint;
  voteEnd: bigint;
  currentRound: number;
  tranchesReleased: number;
  /** 0 = SINGLE, 1 = MILESTONES, null = not set by the operator yet. */
  payoutMode: 0 | 1 | null;
  totalRaised: bigint;
  poolDonated: bigint;
  released: bigint;
  rejectedRemainder: bigint;
  settlementStart: bigint;
  swept: boolean;
  snapshot: Snapshot;
  /** The current round (when a vote is open or was the last one), else null. */
  round: VoteRound | null;
}

export interface DonorPosition {
  address: string;
  donated: bigint;
  preference: "REFUND" | "EMERGENCY_POOL";
  settled: boolean;
  /** This address's vote in the current round, if any. */
  vote: { approve: boolean; weight: bigint } | null;
}

export interface VoteTally {
  cast: bigint;
  /** totalRaised − poolDonated: the weight that can vote (ADR-045). */
  base: bigint;
  /** Turnout in basis points of `base` (0 when base is 0). */
  turnoutBps: bigint;
  /** Yes share in basis points of cast weight (0 with no votes). */
  yesBps: bigint;
  quorumReached: boolean | null;
  approvalReached: boolean | null;
}

/** Turnout and approval exactly as `closeVote()` computes them. */
export function voteTally(lc: CampaignLifecycle): VoteTally | null {
  if (!lc.round) return null;
  const { yes, no } = lc.round;
  const cast = yes + no;
  const base = lc.totalRaised - lc.poolDonated;
  const { quorumBps, approvalBps } = lc.snapshot;
  return {
    cast,
    base,
    turnoutBps: base > 0n ? (cast * BPS) / base : 0n,
    yesBps: cast > 0n ? (yes * BPS) / cast : 0n,
    quorumReached: quorumBps === null ? null : base > 0n && cast * BPS >= base * BigInt(quorumBps),
    approvalReached: approvalBps === null ? null : cast > 0n && yes * BPS >= cast * BigInt(approvalBps),
  };
}

export interface DueActions {
  /** LIVE and the deadline has passed: anyone may call finalize(). */
  finalize: boolean;
  /** VOTING and the vote window is over: anyone may call closeVote(). */
  closeVote: boolean;
  /** SUCCEEDED, payout mode set and (SINGLE) the release delay is over: anyone may call release(). */
  release: boolean;
  /** When release() becomes possible (SINGLE), seconds since epoch; null when not applicable or unknown. */
  releaseAt: bigint | null;
}

export function dueActions(lc: CampaignLifecycle, now: bigint): DueActions {
  let releaseAt: bigint | null = null;
  let release = false;
  if (lc.state === "SUCCEEDED" && lc.payoutMode !== null) {
    if (lc.payoutMode === 1) {
      release = true;
    } else if (lc.snapshot.releaseDelay !== null) {
      releaseAt = lc.endTime + BigInt(lc.snapshot.releaseDelay);
      release = now >= releaseAt;
    }
  }
  return {
    finalize: lc.state === "LIVE" && now >= lc.deadline,
    closeVote: lc.state === "VOTING" && now >= lc.voteEnd,
    release,
    releaseAt,
  };
}

/** What claimRefund / settleToPool pay this donor: all of it after FAILED, pro rata after REJECTED. */
export function settlementAmount(lc: CampaignLifecycle, donated: bigint): bigint {
  if (lc.state === "FAILED") return donated;
  if (lc.state === "REJECTED") return lc.totalRaised > 0n ? (donated * lc.rejectedRemainder) / lc.totalRaised : 0n;
  return 0n;
}

export type DonorAction =
  | { kind: "vote"; weight: bigint }
  | { kind: "voted"; approve: boolean; weight: bigint }
  | { kind: "refund"; amount: bigint }
  | { kind: "pool"; amount: bigint }
  | { kind: "settled" }
  | { kind: "none" };

/** The next thing this donor address can do, or what it already did. */
export function donorAction(lc: CampaignLifecycle, pos: DonorPosition, now: bigint): DonorAction {
  if (pos.donated === 0n) return { kind: "none" };
  if (lc.state === "VOTING") {
    if (pos.vote) return { kind: "voted", approve: pos.vote.approve, weight: pos.vote.weight };
    if (now < lc.voteEnd) return { kind: "vote", weight: pos.donated };
    return { kind: "none" };
  }
  if (lc.state === "FAILED" || lc.state === "REJECTED") {
    if (pos.settled) return { kind: "settled" };
    if (lc.swept) return { kind: "none" };
    const amount = settlementAmount(lc, pos.donated);
    if (amount === 0n) return { kind: "none" };
    return pos.preference === "REFUND" ? { kind: "refund", amount } : { kind: "pool", amount };
  }
  return { kind: "none" };
}

// ── Loaders ──────────────────────────────────────────────────────────────────

const big = (v: unknown) => BigInt(String(v ?? "0"));
const intOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function chainState(v: unknown): ChainState {
  const s = String(v) as ChainState;
  if (!CHAIN_STATES.includes(s)) throw new Error(`unknown campaign state ${String(v)}`);
  return s;
}

type Row = Record<string, unknown>;

/**
 * One campaign's lifecycle. null when the indexer has no such campaign or the
 * chain views are missing. The `snap_*` values are read through `to_jsonb` so a
 * view without those columns gives null instead of an error.
 */
export async function loadLifecycle(db: Database, address: string): Promise<CampaignLifecycle | null> {
  const a = address.toLowerCase();
  try {
    const [c] = (await db.execute(sql`
      select lower(c.address) as address, c.state::text as state, c.deadline::text as deadline, c.end_time::text as end_time,
        c.vote_end::text as vote_end, c.current_round, c.tranches_released, c.payout_mode,
        c.total_raised::text as total_raised, c.pool_donated::text as pool_donated, c.released::text as released,
        c.rejected_remainder::text as rejected_remainder, c.settlement_start::text as settlement_start, c.swept,
        to_jsonb(c)->>'snap_vote_window' as snap_vote_window, to_jsonb(c)->>'snap_quorum_bps' as snap_quorum_bps,
        to_jsonb(c)->>'snap_approval_bps' as snap_approval_bps, to_jsonb(c)->>'snap_release_delay' as snap_release_delay,
        to_jsonb(c)->>'snap_refund_sweep_delay' as snap_refund_sweep_delay
      from chain.campaign c where lower(c.address) = ${a}
    `)) as unknown as Row[];
    if (!c) return null;
    const [r] = (await db.execute(sql`
      select round, bundle_hash, vote_end::text as vote_end, yes_votes::text as yes_votes, no_votes::text as no_votes,
        outcome::text as outcome, closed_at::text as closed_at
      from chain.vote_round where lower(campaign) = ${a} and round = ${Number(c.current_round)}
    `)) as unknown as Row[];
    return {
      address: String(c.address),
      state: chainState(c.state),
      deadline: big(c.deadline),
      endTime: big(c.end_time),
      voteEnd: big(c.vote_end),
      currentRound: Number(c.current_round),
      tranchesReleased: Number(c.tranches_released),
      payoutMode: c.payout_mode === null ? null : (Number(c.payout_mode) as 0 | 1),
      totalRaised: big(c.total_raised),
      poolDonated: big(c.pool_donated),
      released: big(c.released),
      rejectedRemainder: big(c.rejected_remainder),
      settlementStart: big(c.settlement_start),
      swept: Boolean(c.swept),
      snapshot: {
        voteWindow: intOrNull(c.snap_vote_window),
        quorumBps: intOrNull(c.snap_quorum_bps),
        approvalBps: intOrNull(c.snap_approval_bps),
        releaseDelay: intOrNull(c.snap_release_delay),
        refundSweepDelay: intOrNull(c.snap_refund_sweep_delay),
      },
      round: r
        ? {
            round: Number(r.round),
            bundleHash: String(r.bundle_hash),
            voteEnd: big(r.vote_end),
            yes: big(r.yes_votes),
            no: big(r.no_votes),
            outcome: r.outcome === null ? null : chainState(r.outcome),
            closedAt: r.closed_at === null ? null : big(r.closed_at),
          }
        : null,
    };
  } catch (e) {
    if (!isMissingRelation(e)) throw e;
    return null;
  }
}

/** The positions of a user's linked addresses in one campaign (only addresses that donated). */
export async function loadUserPositions(db: Database, userId: string, lc: CampaignLifecycle): Promise<DonorPosition[]> {
  const rows = (await db.execute(sql`
    select lower(cd.donor) as address, cd.donated::text as donated, cd.preference, cd.settled,
      v.approve, v.weight::text as weight
    from chain.campaign_donor cd
    join app.user_addresses ua on ua.address = lower(cd.donor)
    left join chain.vote v on lower(v.campaign) = lower(cd.campaign) and v.round = ${lc.currentRound} and lower(v.voter) = lower(cd.donor)
    where ua.user_id = ${userId} and lower(cd.campaign) = ${lc.address} and cd.donated > 0
    order by cd.donated desc, lower(cd.donor)
  `)) as unknown as Row[];
  return rows.map((r) => ({
    address: String(r.address),
    donated: big(r.donated),
    preference: Number(r.preference) === 1 ? "EMERGENCY_POOL" : "REFUND",
    settled: Boolean(r.settled),
    vote: r.approve === null || r.approve === undefined ? null : { approve: Boolean(r.approve), weight: big(r.weight) },
  }));
}

export interface MyCampaignDonation {
  campaignId: string;
  slug: string;
  title: string;
  lifecycle: CampaignLifecycle;
  positions: DonorPosition[];
}

/**
 * "My donations": every campaign any of the user's addresses donated to, newest
 * campaign first. null when the chain views are missing.
 */
export async function listMyCampaignDonations(db: Database, userId: string): Promise<MyCampaignDonation[] | null> {
  let campaigns: Row[];
  try {
    campaigns = (await db.execute(sql`
      select distinct c.id, c.slug, c.title, c.onchain_address, c.created_at
      from chain.campaign_donor cd
      join app.user_addresses ua on ua.address = lower(cd.donor)
      join app.campaigns c on c.onchain_address = lower(cd.campaign)
      where ua.user_id = ${userId} and cd.donated > 0
      order by c.created_at desc
    `)) as unknown as Row[];
  } catch (e) {
    if (!isMissingRelation(e)) throw e;
    return null;
  }
  const out: MyCampaignDonation[] = [];
  for (const c of campaigns) {
    const lifecycle = await loadLifecycle(db, String(c.onchain_address));
    if (!lifecycle) continue;
    out.push({
      campaignId: String(c.id),
      slug: String(c.slug),
      title: String(c.title),
      lifecycle,
      positions: await loadUserPositions(db, userId, lifecycle),
    });
  }
  return out;
}

/** Open votes where one of the user's addresses can still vote (the "votes waiting" badge). */
export function votesWaiting(list: MyCampaignDonation[], now: bigint): number {
  return list.filter((d) => d.positions.some((p) => donorAction(d.lifecycle, p, now).kind === "vote")).length;
}

// ── JSON (API) ───────────────────────────────────────────────────────────────

const s = (v: bigint) => v.toString();

/** A lifecycle with its tally and due actions, bigints as decimal strings. */
export function lifecycleJson(lc: CampaignLifecycle, now: bigint) {
  const tally = voteTally(lc);
  const due = dueActions(lc, now);
  return {
    address: lc.address,
    state: lc.state,
    deadline: s(lc.deadline),
    endTime: s(lc.endTime),
    voteEnd: s(lc.voteEnd),
    currentRound: lc.currentRound,
    tranchesReleased: lc.tranchesReleased,
    payoutMode: lc.payoutMode === null ? null : lc.payoutMode === 0 ? "SINGLE" : "MILESTONES",
    totalRaised: s(lc.totalRaised),
    poolDonated: s(lc.poolDonated),
    released: s(lc.released),
    swept: lc.swept,
    snapshot: lc.snapshot,
    round: lc.round && {
      round: lc.round.round, bundleHash: lc.round.bundleHash, voteEnd: s(lc.round.voteEnd), yes: s(lc.round.yes), no: s(lc.round.no),
      outcome: lc.round.outcome, closedAt: lc.round.closedAt === null ? null : s(lc.round.closedAt),
    },
    tally: tally && {
      cast: s(tally.cast), base: s(tally.base), turnoutBps: Number(tally.turnoutBps), yesBps: Number(tally.yesBps),
      quorumReached: tally.quorumReached, approvalReached: tally.approvalReached,
    },
    due: { finalize: due.finalize, closeVote: due.closeVote, release: due.release, releaseAt: due.releaseAt === null ? null : s(due.releaseAt) },
  };
}

/** One donor address with its next action, bigints as decimal strings. */
export function positionJson(lc: CampaignLifecycle, pos: DonorPosition, now: bigint) {
  const action = donorAction(lc, pos, now);
  return {
    address: pos.address,
    donated: s(pos.donated),
    preference: pos.preference,
    settled: pos.settled,
    vote: pos.vote && { approve: pos.vote.approve, weight: s(pos.vote.weight) },
    action:
      action.kind === "vote" ? { kind: action.kind, weight: s(action.weight) }
      : action.kind === "voted" ? { kind: action.kind, approve: action.approve, weight: s(action.weight) }
      : action.kind === "refund" || action.kind === "pool" ? { kind: action.kind, amount: s(action.amount) }
      : { kind: action.kind },
  };
}

export const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000));

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
  const map = await loadLifecycles(db, [a]);
  return map?.get(a) ?? null;
}

/**
 * Several campaigns' lifecycles in two queries (TASK-047: "My donations" read
 * them one by one). Keyed by the lower-case address; campaigns the indexer does
 * not know are missing. null when the chain views are missing.
 */
export async function loadLifecycles(db: Database, addresses: string[]): Promise<Map<string, CampaignLifecycle> | null> {
  const list = [...new Set(addresses.map((a) => a.toLowerCase()))];
  const out = new Map<string, CampaignLifecycle>();
  if (list.length === 0) return out;
  const any = sql`any(array[${sql.join(list.map((a) => sql`${a}`), sql`, `)}]::text[])`;
  try {
    const campaigns = (await db.execute(sql`
      select c.address, c.state::text as state, c.deadline::text as deadline, c.end_time::text as end_time,
        c.vote_end::text as vote_end, c.current_round, c.tranches_released, c.payout_mode,
        c.total_raised::text as total_raised, c.pool_donated::text as pool_donated, c.released::text as released,
        c.rejected_remainder::text as rejected_remainder, c.settlement_start::text as settlement_start, c.swept,
        to_jsonb(c)->>'snap_vote_window' as snap_vote_window, to_jsonb(c)->>'snap_quorum_bps' as snap_quorum_bps,
        to_jsonb(c)->>'snap_approval_bps' as snap_approval_bps, to_jsonb(c)->>'snap_release_delay' as snap_release_delay,
        to_jsonb(c)->>'snap_refund_sweep_delay' as snap_refund_sweep_delay
      from chain.campaign c where c.address = ${any}
    `)) as unknown as Row[];
    if (campaigns.length === 0) return out;
    const rounds = (await db.execute(sql`
      select r.campaign, r.round, r.bundle_hash, r.vote_end::text as vote_end, r.yes_votes::text as yes_votes,
        r.no_votes::text as no_votes, r.outcome::text as outcome, r.closed_at::text as closed_at
      from chain.vote_round r
      join chain.campaign c on c.address = r.campaign and c.current_round = r.round
      where r.campaign = ${any}
    `)) as unknown as Row[];
    const roundOf = new Map(rounds.map((r) => [String(r.campaign), r]));
    for (const c of campaigns) {
      const r = roundOf.get(String(c.address));
      out.set(String(c.address), {
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
      });
    }
    return out;
  } catch (e) {
    if (!isMissingRelation(e)) throw e;
    return null;
  }
}

/** The positions of a user's linked addresses in one campaign (only addresses that donated). */
export async function loadUserPositions(db: Database, userId: string, lc: CampaignLifecycle): Promise<DonorPosition[]> {
  return (await loadUserPositionsMany(db, userId, [lc])).get(lc.address) ?? [];
}

/** loadUserPositions for several campaigns in one query (TASK-047), keyed by campaign address. */
export async function loadUserPositionsMany(
  db: Database, userId: string, lifecycles: CampaignLifecycle[]
): Promise<Map<string, DonorPosition[]>> {
  const out = new Map<string, DonorPosition[]>();
  if (lifecycles.length === 0) return out;
  // The vote of the round each lifecycle was read at (not the round right now).
  const pairs = sql.join(lifecycles.map((lc) => sql`(${lc.address}::text, ${lc.currentRound}::int)`), sql`, `);
  const rows = (await db.execute(sql`
    select cd.campaign, cd.donor as address, cd.donated::text as donated, cd.preference, cd.settled,
      v.approve, v.weight::text as weight
    from (values ${pairs}) as l(campaign, round)
    join chain.campaign_donor cd on cd.campaign = l.campaign
    join app.user_addresses ua on ua.address = cd.donor
    left join chain.vote v on v.campaign = cd.campaign and v.round = l.round and v.voter = cd.donor
    where ua.user_id = ${userId} and cd.donated > 0
    order by cd.campaign, cd.donated desc, cd.donor
  `)) as unknown as Row[];
  for (const r of rows) {
    const list = out.get(String(r.campaign)) ?? [];
    list.push({
      address: String(r.address),
      donated: big(r.donated),
      preference: Number(r.preference) === 1 ? "EMERGENCY_POOL" : "REFUND",
      settled: Boolean(r.settled),
      vote: r.approve === null || r.approve === undefined ? null : { approve: Boolean(r.approve), weight: big(r.weight) },
    });
    out.set(String(r.campaign), list);
  }
  return out;
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
      join app.user_addresses ua on ua.address = cd.donor
      join app.campaigns c on c.onchain_address = cd.campaign
      where ua.user_id = ${userId} and cd.donated > 0
      order by c.created_at desc
    `)) as unknown as Row[];
  } catch (e) {
    if (!isMissingRelation(e)) throw e;
    return null;
  }
  // Three queries in all, however many campaigns (TASK-047).
  const lifecycles = await loadLifecycles(db, campaigns.map((c) => String(c.onchain_address)));
  if (lifecycles === null) return null;
  const found = campaigns.flatMap((c) => {
    const lifecycle = lifecycles.get(String(c.onchain_address));
    return lifecycle ? [{ c, lifecycle }] : [];
  });
  const positions = await loadUserPositionsMany(db, userId, found.map((f) => f.lifecycle));
  return found.map(({ c, lifecycle }) => ({
    campaignId: String(c.id),
    slug: String(c.slug),
    title: String(c.title),
    lifecycle,
    positions: positions.get(lifecycle.address) ?? [],
  }));
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

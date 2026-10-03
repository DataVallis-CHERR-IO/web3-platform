import { sql } from "drizzle-orm";
import type { Database } from "@cherrio/db";
import { getChainConfig, parseAppEnv } from "@cherrio/shared";
import { publicMediaUrl } from "@/lib/media/public-store";
import { isMissingRelation } from "./publish";

// Public, read-only view of published campaigns (TASK-011a).
// Off-chain data comes from `app.*`; on-chain figures only from the `chain.*`
// views the indexer publishes (ADR-026) — never from an RPC. When the views are
// missing, pages still render from `app.*` with `onChain: null`.
// Donor names follow ADR-043.

export const PUBLIC_PAGE_SIZE = 24;
export const DONATIONS_PAGE_SIZE = 50;

/** What a visitor sees as the campaign's state. */
export type PublicState =
  | "live" // LIVE on chain and before the deadline
  | "ending" // LIVE on chain but the deadline has passed; waits for finalize()
  | "succeeded"
  | "voting"
  | "completed"
  | "failed"
  | "frozen"
  | "needs-review"
  | "rejected"
  | "unknown"; // no chain data (indexer unavailable or not indexed yet)

export interface OnChainFigures {
  state: PublicState;
  raised: bigint;
  /** null until the campaign has been finalized */
  payoutMode: "SINGLE" | "MILESTONES" | null;
  donors: number;
  /** Seconds since epoch; 0 while the campaign is live. */
  endTime: bigint;
}

export interface PublicCampaignSummary {
  id: string;
  slug: string;
  title: string;
  orgName: string;
  orgVerified: boolean;
  cause: string;
  country: string;
  coverUrl: string | null;
  targetEurCents: bigint;
  targetUsdc: bigint;
  deadline: Date;
  address: string;
  onChain: OnChainFigures | null;
}

export interface PublicCampaign extends PublicCampaignSummary {
  story: string;
}

export interface PublicDonation {
  id: string;
  donor: string;
  /** ADR-043: a display name, "anonymous", or null for an unknown address. */
  donorName: { kind: "named"; name: string } | { kind: "anonymous" } | { kind: "unknown" };
  amount: bigint;
  /** Seconds since epoch */
  blockTime: bigint;
  txHash: string;
}

const CHAIN_STATES: Record<string, PublicState> = {
  LIVE: "live",
  SUCCEEDED: "succeeded",
  PAYING: "succeeded",
  VOTING: "voting",
  COMPLETED: "completed",
  FAILED: "failed",
  FROZEN: "frozen",
  NEEDS_REVIEW: "needs-review",
  REJECTED: "rejected",
};

export function toPublicState(chainState: string | null, deadlineEpoch: bigint, nowEpoch: bigint): PublicState {
  if (chainState === null) return "unknown";
  const state = CHAIN_STATES[chainState] ?? "unknown";
  if (state === "live" && nowEpoch >= deadlineEpoch) return "ending";
  return state;
}

/** Explorer URLs for the current environment; null where there is no explorer (local chain). */
export function explorerUrls(): { tx: string; address: string } | null {
  const base = getChainConfig(parseAppEnv(process.env.APP_ENV)).chain.blockExplorerUrl;
  if (!base) return null;
  return { tx: `${base}/tx/`, address: `${base}/address/` };
}

interface SummaryRow {
  id: string;
  slug: string;
  title: string;
  org_name: string;
  kyb_status: string;
  cause: string;
  country: string;
  cover_cid: string | null;
  target_eur_cents: string;
  target_usdc: string;
  deadline: string;
  address: string;
  story?: { text?: string } | null;
  chain_state?: string | null;
  chain_deadline?: string | null;
  total_raised?: string | null;
  payout_mode?: number | null;
  end_time?: string | null;
  donors?: string | number | null;
}

const nowEpoch = () => BigInt(Math.floor(Date.now() / 1000));

function toSummary(row: SummaryRow, withChain: boolean): PublicCampaignSummary {
  const deadline = new Date(row.deadline);
  const deadlineEpoch = row.chain_deadline ? BigInt(row.chain_deadline) : BigInt(Math.floor(deadline.getTime() / 1000));
  const onChain: OnChainFigures | null =
    withChain && row.chain_state
      ? {
          state: toPublicState(row.chain_state, deadlineEpoch, nowEpoch()),
          raised: BigInt(row.total_raised ?? "0"),
          payoutMode: row.payout_mode === 0 ? "SINGLE" : row.payout_mode === 1 ? "MILESTONES" : null,
          donors: Number(row.donors ?? 0),
          endTime: BigInt(row.end_time ?? "0"),
        }
      : null;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    orgName: row.org_name,
    orgVerified: row.kyb_status === "APPROVED",
    cause: row.cause,
    country: row.country,
    coverUrl: row.cover_cid ? publicMediaUrl(row.cover_cid) : null,
    targetEurCents: BigInt(row.target_eur_cents),
    targetUsdc: BigInt(row.target_usdc),
    deadline,
    address: row.address,
    onChain,
  };
}

// Columns shared by the list and the detail query. Only DEPLOYED campaigns with
// a linked contract are public.
const appColumns = sql`
  c.id, c.slug, c.title, o.name as org_name, o.kyb_status::text as kyb_status, c.cause, c.country,
  cover.cid as cover_cid, c.target_eur_cents::text as target_eur_cents, c.target_usdc::text as target_usdc,
  c.deadline::text as deadline, c.onchain_address as address
`;
const appFrom = sql`
  from app.campaigns c
  join app.organizations o on o.id = c.org_id
  left join lateral (
    select m.cid from app.campaign_media m
    where m.campaign_id = c.id and m.kind = 'COVER'
    order by m.created_at desc limit 1
  ) cover on true
`;
const chainColumns = sql`
  ch.state::text as chain_state, ch.deadline::text as chain_deadline, ch.total_raised::text as total_raised,
  ch.payout_mode, ch.end_time::text as end_time,
  (select count(*) from chain.campaign_donor cd where lower(cd.campaign) = c.onchain_address) as donors
`;
const chainJoin = sql`left join chain.campaign ch on lower(ch.address) = c.onchain_address`;
const publicWhere = sql`where c.status = 'DEPLOYED' and c.onchain_address is not null`;

/**
 * Published campaigns, live ones first (soonest deadline first), then ended
 * ones (latest end first). `total` counts all published campaigns.
 */
export async function listPublicCampaigns(
  db: Database,
  { page = 1 }: { page?: number } = {}
): Promise<{ campaigns: PublicCampaignSummary[]; total: number; page: number; pageCount: number; chainAvailable: boolean }> {
  const [countRow] = (await db.execute(sql`select count(*)::int as n from app.campaigns c ${publicWhere}`)) as unknown as {
    n: number;
  }[];
  const total = countRow?.n ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PUBLIC_PAGE_SIZE));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const offset = (current - 1) * PUBLIC_PAGE_SIZE;

  try {
    const rows = (await db.execute(sql`
      select ${appColumns}, ${chainColumns}
      ${appFrom}
      ${chainJoin}
      ${publicWhere}
      order by
        case when ch.state::text = 'LIVE' and c.deadline > now() then 0 else 1 end,
        case when ch.state::text = 'LIVE' and c.deadline > now() then c.deadline end asc,
        coalesce(nullif(ch.end_time, 0)::bigint, extract(epoch from c.deadline)::bigint) desc,
        c.id
      limit ${PUBLIC_PAGE_SIZE} offset ${offset}
    `)) as unknown as SummaryRow[];
    return { campaigns: rows.map((r) => toSummary(r, true)), total, page: current, pageCount, chainAvailable: true };
  } catch (e) {
    if (!isMissingRelation(e)) throw e;
    const rows = (await db.execute(sql`
      select ${appColumns}
      ${appFrom}
      ${publicWhere}
      order by c.deadline desc, c.id
      limit ${PUBLIC_PAGE_SIZE} offset ${offset}
    `)) as unknown as SummaryRow[];
    return { campaigns: rows.map((r) => toSummary(r, false)), total, page: current, pageCount, chainAvailable: false };
  }
}

/** One published campaign by slug, or null (unknown slug or not DEPLOYED). */
export async function getPublicCampaign(
  db: Database,
  slug: string
): Promise<{ campaign: PublicCampaign; chainAvailable: boolean } | null> {
  const toCampaign = (row: SummaryRow, withChain: boolean): PublicCampaign => ({
    ...toSummary(row, withChain),
    story: typeof row.story?.text === "string" ? row.story.text : "",
  });
  try {
    const [row] = (await db.execute(sql`
      select ${appColumns}, c.story, ${chainColumns}
      ${appFrom}
      ${chainJoin}
      ${publicWhere} and c.slug = ${slug}
      limit 1
    `)) as unknown as SummaryRow[];
    return row ? { campaign: toCampaign(row, true), chainAvailable: true } : null;
  } catch (e) {
    if (!isMissingRelation(e)) throw e;
    const [row] = (await db.execute(sql`
      select ${appColumns}, c.story
      ${appFrom}
      ${publicWhere} and c.slug = ${slug}
      limit 1
    `)) as unknown as SummaryRow[];
    return row ? { campaign: toCampaign(row, false), chainAvailable: false } : null;
  }
}

interface DonationRow {
  id: string;
  donor: string;
  amount: string;
  block_time: string;
  tx_hash: string;
  display_name: string | null;
  anonymous_donations: boolean | null;
}

/** ADR-043: name unless the user chose anonymity; unknown addresses stay addresses. */
export function donorName(row: Pick<DonationRow, "display_name" | "anonymous_donations">): PublicDonation["donorName"] {
  if (row.display_name === null || row.anonymous_donations === null) return { kind: "unknown" };
  if (row.anonymous_donations) return { kind: "anonymous" };
  return { kind: "named", name: row.display_name };
}

/** Donations to a campaign contract, newest first; null when the chain views are missing. */
export async function listCampaignDonations(
  db: Database,
  address: string,
  { page = 1 }: { page?: number } = {}
): Promise<{ donations: PublicDonation[]; total: number; page: number; pageCount: number } | null> {
  const campaign = address.toLowerCase();
  try {
    const [countRow] = (await db.execute(sql`
      select count(*)::int as n from chain.donation where lower(campaign) = ${campaign}
    `)) as unknown as { n: number }[];
    const total = countRow?.n ?? 0;
    const pageCount = Math.max(1, Math.ceil(total / DONATIONS_PAGE_SIZE));
    const current = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
    const rows = (await db.execute(sql`
      select d.id, lower(d.donor) as donor, d.amount::text as amount, d.block_time::text as block_time, d.tx_hash,
             u.display_name, u.anonymous_donations
      from chain.donation d
      left join app.user_addresses ua on ua.address = lower(d.donor)
      left join app.users u on u.id = ua.user_id
      where lower(d.campaign) = ${campaign}
      order by d.block_number desc, d.log_index desc
      limit ${DONATIONS_PAGE_SIZE} offset ${(current - 1) * DONATIONS_PAGE_SIZE}
    `)) as unknown as DonationRow[];
    return {
      donations: rows.map((r) => ({
        id: r.id,
        donor: r.donor,
        donorName: donorName(r),
        amount: BigInt(r.amount),
        blockTime: BigInt(r.block_time),
        txHash: r.tx_hash,
      })),
      total,
      page: current,
      pageCount,
    };
  } catch (e) {
    if (!isMissingRelation(e)) throw e;
    return null;
  }
}

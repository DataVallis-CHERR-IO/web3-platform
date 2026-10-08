import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@cherrio/db";
import { COUNTRY_CODES, ORGANIZATION_CAUSES, getChainConfig, parseAppEnv, type OrganizationCause } from "@cherrio/shared";
import { containsText } from "@/lib/admin/listing";
import { DEFAULT_CAMPAIGN_SORT, MAX_SEARCH_LENGTH, type CampaignSort } from "./filter-options";
export { CAMPAIGN_SORTS, DEFAULT_CAMPAIGN_SORT, MAX_SEARCH_LENGTH, parseCampaignSort, type CampaignSort } from "./filter-options";
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
  orgId: string;
  orgName: string;
  orgVerified: boolean;
  cause: string;
  country: string;
  coverUrl: string | null;
  targetEurCents: bigint;
  targetUsdc: bigint;
  deadline: Date;
  address: string;
  /** ADR-052: a made-up campaign for testing (local/dev only). */
  isDemo: boolean;
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
  org_id: string;
  org_name: string;
  kyb_status: string;
  cause: string;
  country: string;
  cover_cid: string | null;
  target_eur_cents: string;
  target_usdc: string;
  deadline: string;
  address: string;
  is_demo: boolean;
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
    orgId: row.org_id,
    orgName: row.org_name,
    orgVerified: row.kyb_status === "APPROVED",
    cause: row.cause,
    country: row.country,
    coverUrl: row.cover_cid ? publicMediaUrl(row.cover_cid) : null,
    targetEurCents: BigInt(row.target_eur_cents),
    targetUsdc: BigInt(row.target_usdc),
    deadline,
    address: row.address,
    isDemo: row.is_demo === true,
    onChain,
  };
}

// Columns shared by the list and the detail query. Only DEPLOYED campaigns with
// a linked contract are public.
const appColumns = sql`
  c.id, c.slug, c.title, o.id as org_id, o.name as org_name, o.kyb_status::text as kyb_status, c.cause, c.country,
  cover.cid as cover_cid, c.target_eur_cents::text as target_eur_cents, c.target_usdc::text as target_usdc,
  c.deadline::text as deadline, c.onchain_address as address, c.is_demo
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
  (select count(*) from chain.campaign_donor cd where cd.campaign = c.onchain_address) as donors
`;
// The indexer writes every hex value lower-case (Ponder's hex column), and
// `onchain_address` is lower-case by its check constraint: compare the columns
// as they are, so the views' primary keys and indexes are used (TASK-047 —
// `lower(ch.address)` made every list a sequential scan of the chain tables).
const chainJoin = sql`left join chain.campaign ch on ch.address = c.onchain_address`;
const publicWhere = sql`where c.status = 'DEPLOYED' and c.onchain_address is not null`;

/**
 * Filters on the public campaign list (TASK-039; multi-select TASK-042).
 * Several values in one group match any of them; groups combine (cause AND
 * country). Empty = no filter.
 */
export interface CampaignFilters {
  causes?: OrganizationCause[];
  /** ISO 3166-1 alpha-2, upper case */
  countries?: string[];
  /** Text search over the campaign title and the organisation name (TASK-053); trimmed, at most 100 characters. */
  q?: string;
}


/** At most this many values per group are read from the URL. */
export const MAX_FILTER_VALUES = 50;

function queryValues(v: string | string[] | undefined): string[] {
  return (Array.isArray(v) ? v : v === undefined ? [] : [v]).flatMap((x) => x.split(","));
}

function pick(values: string[], normalise: (v: string) => string, allowed: (v: string) => boolean): string[] {
  const out: string[] = [];
  for (const raw of values) {
    const v = normalise(raw.trim());
    if (v && allowed(v) && !out.includes(v)) out.push(v);
    if (out.length === MAX_FILTER_VALUES) break;
  }
  return out;
}

/**
 * Filters from URL query values (`?cause=a&cause=b` or `?cause=a,b`).
 * Unknown causes and countries are dropped (the list then shows everything
 * instead of an error page); duplicates are removed.
 */
export function parseCampaignFilters(query: {
  cause?: string | string[];
  country?: string | string[];
  q?: string | string[];
}): CampaignFilters {
  const filters: CampaignFilters = {};
  const causes = pick(queryValues(query.cause), (v) => v.toLowerCase(), (v) => (ORGANIZATION_CAUSES as readonly string[]).includes(v));
  if (causes.length > 0) filters.causes = causes as OrganizationCause[];
  const countries = pick(queryValues(query.country), (v) => v.toUpperCase(), (v) => COUNTRY_CODES.includes(v));
  if (countries.length > 0) filters.countries = countries;
  const q = ((Array.isArray(query.q) ? query.q[0] : query.q) ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_SEARCH_LENGTH).trim();
  if (q) filters.q = q;
  return filters;
}

const inList = (values: string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

/**
 * The filter conditions after `publicWhere`. The text search needs the
 * organisation (`o`) joined; every query that passes `q` joins it.
 */
function filterSql({ causes, countries, q }: CampaignFilters) {
  return sql`${causes?.length ? sql` and c.cause in (${inList(causes)})` : sql``}${
    countries?.length ? sql` and c.country in (${inList(countries)})` : sql``
  }${q ? sql` and (${containsText(sql`c.title`, q)} or ${containsText(sql`o.name`, q)})` : sql``}`;
}

export interface CampaignFacets {
  /** Causes with published campaigns, within the country filter (any chosen country). */
  causes: { cause: OrganizationCause; count: number }[];
  /** Countries with published campaigns, within the cause filter (any chosen cause). */
  countries: { country: string; count: number }[];
}

/**
 * What the filter controls offer: each cause counts campaigns in the chosen
 * country, each country counts campaigns of the chosen cause, so a choice
 * never leads to a dead end it could have shown.
 */
export async function listCampaignFacets(db: Database, filters: CampaignFilters = {}): Promise<CampaignFacets> {
  const causeRows = (await db.execute(sql`
    select c.cause::text as value, count(*)::int as n from app.campaigns c
    join app.organizations o on o.id = c.org_id
    ${publicWhere}${filterSql({ countries: filters.countries, q: filters.q })}
    group by c.cause
  `)) as unknown as { value: string; n: number }[];
  const countryRows = (await db.execute(sql`
    select c.country as value, count(*)::int as n from app.campaigns c
    join app.organizations o on o.id = c.org_id
    ${publicWhere}${filterSql({ causes: filters.causes, q: filters.q })}
    group by c.country order by c.country
  `)) as unknown as { value: string; n: number }[];
  const causeCount = new Map(causeRows.map((r) => [r.value, r.n]));
  return {
    // The fixed order of ORGANIZATION_CAUSES, not by count: chips stay in place.
    causes: ORGANIZATION_CAUSES.filter((cause) => causeCount.has(cause)).map((cause) => ({
      cause,
      count: causeCount.get(cause)!,
    })),
    countries: countryRows.map((r) => ({ country: r.value, count: r.n })),
  };
}

/**
 * Two steps (TASK-047): `page` picks the ids and sort keys (k_live, k_deadline,
 * k_end) from the narrow join of campaigns and chain.campaign; only those rows
 * then get their cover, organisation and donor count — not every published campaign.
 */
async function summariesOf(db: Database, page: SQL, order: SQL = sql`p.k_live, p.k_deadline asc, p.k_end desc, p.id`): Promise<SummaryRow[]> {
  return (await db.execute(sql`
    with page as (${page})
    select ${appColumns}, ${chainColumns}
    from page p
    join app.campaigns c on c.id = p.id
    join app.organizations o on o.id = c.org_id
    left join lateral (
      select m.cid from app.campaign_media m
      where m.campaign_id = c.id and m.kind = 'COVER'
      order by m.created_at desc limit 1
    ) cover on true
    ${chainJoin}
    order by ${order}
  `)) as unknown as SummaryRow[];
}

/**
 * The live campaigns whose deadline comes first (the landing page, TASK-037),
 * in the order of `listPublicCampaigns`' live section, through the partial
 * index on `deadline` (TASK-047): it stops after `limit` rows instead of sorting
 * every published campaign. null when the chain views are missing.
 */
export async function listLiveCampaigns(db: Database, limit: number): Promise<PublicCampaignSummary[] | null> {
  try {
    const rows = await summariesOf(db, sql`
      select c.id, 0 as k_live, c.deadline as k_deadline, extract(epoch from c.deadline)::bigint as k_end
      from app.campaigns c
      join app.organizations o on o.id = c.org_id
      join chain.campaign ch on ch.address = c.onchain_address
      ${publicWhere} and c.deadline > now() and ch.state::text = 'LIVE'
      order by c.deadline asc, c.id
      limit ${limit}
    `);
    return rows.map((r) => toSummary(r, true));
  } catch (e) {
    if (!isMissingRelation(e)) throw e;
    return null;
  }
}

/** Number of published campaigns (any state). */
export async function countPublicCampaigns(db: Database): Promise<number> {
  const [row] = (await db.execute(sql`select count(*)::int as n from app.campaigns c ${publicWhere}`)) as unknown as { n: number }[];
  return row?.n ?? 0;
}

/**
 * Inner and outer ORDER BY of each sort (TASK-053). The inner one sorts the
 * page query's rows (`c`, `ch` and the k_* keys); the outer one keeps that
 * order for the page's rows (`p.*`). Ties always end on the id.
 */
const SORT_ORDER: Record<CampaignSort, { inner: SQL; outer: SQL }> = {
  ending: {
    inner: sql`k_live, k_deadline asc, k_end desc, c.id`,
    outer: sql`p.k_live, p.k_deadline asc, p.k_end desc, p.id`,
  },
  newest: {
    inner: sql`k_live, k_published desc, c.id`,
    outer: sql`p.k_live, p.k_published desc, p.id`,
  },
  raised: {
    inner: sql`k_live, k_raised desc, k_deadline asc, k_end desc, c.id`,
    outer: sql`p.k_live, p.k_raised desc, p.k_deadline asc, p.k_end desc, p.id`,
  },
};

/**
 * Published campaigns in the chosen order (default: live ones first, soonest
 * deadline first, then ended ones, latest end first). `total` counts the
 * published campaigns that match the filters and the search.
 */
export async function listPublicCampaigns(
  db: Database,
  { page = 1, sort = DEFAULT_CAMPAIGN_SORT, ...filters }: { page?: number; sort?: CampaignSort } & CampaignFilters = {}
): Promise<{ campaigns: PublicCampaignSummary[]; total: number; page: number; pageCount: number; chainAvailable: boolean }> {
  const where = sql`${publicWhere}${filterSql(filters)}`;
  const order = SORT_ORDER[sort] ?? SORT_ORDER[DEFAULT_CAMPAIGN_SORT];
  const [countRow] = (await db.execute(sql`
    select count(*)::int as n from app.campaigns c join app.organizations o on o.id = c.org_id ${where}
  `)) as unknown as {
    n: number;
  }[];
  const total = countRow?.n ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PUBLIC_PAGE_SIZE));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const offset = (current - 1) * PUBLIC_PAGE_SIZE;

  try {
    const rows = await summariesOf(db, sql`
      select c.id,
        case when ch.state::text = 'LIVE' and c.deadline > now() then 0 else 1 end as k_live,
        case when ch.state::text = 'LIVE' and c.deadline > now() then c.deadline end as k_deadline,
        coalesce(nullif(ch.end_time, 0)::bigint, extract(epoch from c.deadline)::bigint) as k_end,
        coalesce(c.deployed_at, c.created_at) as k_published,
        coalesce(ch.total_raised, 0) as k_raised
      from app.campaigns c
      join app.organizations o on o.id = c.org_id
      ${chainJoin}
      ${where}
      order by ${order.inner}
      limit ${PUBLIC_PAGE_SIZE} offset ${offset}
    `, order.outer);
    return { campaigns: rows.map((r) => toSummary(r, true)), total, page: current, pageCount, chainAvailable: true };
  } catch (e) {
    if (!isMissingRelation(e)) throw e;
    const rows = (await db.execute(sql`
      select ${appColumns}
      ${appFrom}
      ${where}
      order by ${sort === "newest" ? sql`coalesce(c.deployed_at, c.created_at) desc` : sql`c.deadline desc`}, c.id
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
      select count(*)::int as n from chain.donation where campaign = ${campaign}
    `)) as unknown as { n: number }[];
    const total = countRow?.n ?? 0;
    const pageCount = Math.max(1, Math.ceil(total / DONATIONS_PAGE_SIZE));
    const current = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
    const rows = (await db.execute(sql`
      select d.id, d.donor, d.amount::text as amount, d.block_time::text as block_time, d.tx_hash,
             u.display_name, u.anonymous_donations
      from chain.donation d
      left join app.user_addresses ua on ua.address = d.donor
      left join app.users u on u.id = ua.user_id
      where d.campaign = ${campaign}
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

// ── Donating (TASK-011b) ──────────────────────────────────────────────────────

export interface DonationTheme {
  poolId: number;
  slug: string;
}

/**
 * Emergency Pool themes a donor can choose for the failure preference: the
 * seeded sub-pools (`app.emergency_subpools`, pool 0 excluded — it is the general
 * pool) that also exist on chain (`chain.pool`). Empty when the views are missing.
 */
export async function listDonationThemes(db: Database): Promise<DonationTheme[]> {
  try {
    const rows = (await db.execute(sql`
      select s.pool_id, s.slug from app.emergency_subpools s
      join chain.pool p on p.id = s.pool_id
      where s.pool_id > 0
      order by s.pool_id
    `)) as unknown as { pool_id: number; slug: string }[];
    return rows.map((r) => ({ poolId: Number(r.pool_id), slug: r.slug }));
  } catch (e) {
    if (!isMissingRelation(e)) throw e;
    return [];
  }
}

export interface MyDonation {
  address: string;
  donated: bigint;
  /** 0 = REFUND, 1 = EMERGENCY_POOL */
  preference: number;
  subPoolId: number;
}

/**
 * What the user gave to one campaign, per linked address (`chain.campaign_donor`
 * → `app.user_addresses`). Empty when they have not donated; null when the chain
 * views are missing.
 */
export async function listMyDonations(db: Database, userId: string, campaign: string): Promise<MyDonation[] | null> {
  try {
    const rows = (await db.execute(sql`
      select cd.donor as address, cd.donated::text as donated, cd.preference, cd.sub_pool_id
      from chain.campaign_donor cd
      join app.user_addresses ua on ua.address = cd.donor
      where ua.user_id = ${userId} and cd.campaign = ${campaign.toLowerCase()} and cd.donated > 0
      order by cd.donated desc, cd.donor
    `)) as unknown as { address: string; donated: string; preference: number; sub_pool_id: number }[];
    return rows.map((r) => ({
      address: r.address,
      donated: BigInt(r.donated),
      preference: Number(r.preference),
      subPoolId: Number(r.sub_pool_id),
    }));
  } catch (e) {
    if (!isMissingRelation(e)) throw e;
    return null;
  }
}

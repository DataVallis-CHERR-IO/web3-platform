import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  createPublicClient, fallback, getAddress, http, isAddress, isAddressEqual, recoverTypedDataAddress, type Address, type Hex,
} from "viem";
import { auditLog, ratings, userAddresses, type Database } from "@cherrio/db";
import { parseAppEnv } from "@cherrio/shared";
import {
  RATEABLE_CAMPAIGN_STATES, RATING_COMMENT_MAX, RATING_ISSUED_AT_TOLERANCE_S, RATING_WINDOW_DAYS,
  normaliseRatingComment, ratingTypedData,
} from "@cherrio/shared/ratings";
import { rpcUpstreams } from "@/lib/chain/rpc-proxy";

// Ratings of organisations (ADR-058, TASK-057): who may rate a campaign, the
// signature check and the save. A donor rates the organisation behind a
// finished campaign (COMPLETED / FAILED / REJECTED) for 90 days, signed with a
// linked wallet (EIP-712); one rating per donor and campaign, changeable.

export type RatingStatus =
  | "open"
  | "not_found" // no deployed campaign with this id / not on chain yet
  | "individual" // a campaign of an individual: no organisation to rate
  | "not_finished"
  | "window_closed"
  | "not_donor"
  | "own"; // starter or member of the organisation

export interface OwnRating {
  stars: number;
  comment: string | null;
  updatedAt: Date;
}

export interface RatingContext {
  status: RatingStatus;
  campaignId: string;
  orgId: string | null;
  campaignAddress: Address | null;
  /** End of the rating window (null before the campaign is finished). */
  windowEndsAt: Date | null;
  rating: OwnRating | null;
}

const WINDOW_S = BigInt(RATING_WINDOW_DAYS) * 86_400n;

/** When the rating window opens (unix seconds), from the campaign's chain data. */
export function ratingWindowStart(c: { state: string; endTime: bigint; settlementStart: bigint; lastRelease: bigint | null }): bigint | null {
  if (!(RATEABLE_CAMPAIGN_STATES as readonly string[]).includes(c.state)) return null;
  if (c.state === "COMPLETED") return c.lastRelease ?? c.endTime;
  return c.settlementStart > 0n ? c.settlementStart : c.endTime;
}

export async function loadRatingContext(db: Database, campaignId: string, userId: string, now = new Date()): Promise<RatingContext> {
  const [row] = (await db.execute(sql`
    select a.id, a.org_id, a.beneficiary_type::text as beneficiary_type, a.onchain_address,
           ch.state::text as state, ch.end_time::text as end_time, ch.settlement_start::text as settlement_start,
           (select max(t.block_time) from chain.tranche_release t where t.campaign = a.onchain_address)::text as last_release,
           (a.starter_user_id = ${userId}
             or exists (select 1 from app.org_members m where m.org_id = a.org_id and m.user_id = ${userId})) as own,
           exists (
             select 1 from chain.donation d join app.user_addresses ua on ua.address = d.donor
             where d.campaign = a.onchain_address and ua.user_id = ${userId}
           ) as donor
    from app.campaigns a
    join chain.campaign ch on ch.address = a.onchain_address
    where a.id = ${campaignId} and a.status = 'DEPLOYED'
  `)) as unknown as {
    id: string; org_id: string | null; beneficiary_type: string; onchain_address: string; state: string;
    end_time: string; settlement_start: string; last_release: string | null; own: boolean; donor: boolean;
  }[];
  const base = { campaignId, orgId: null, campaignAddress: null, windowEndsAt: null, rating: null };
  if (!row) return { ...base, status: "not_found" };
  const ctx: RatingContext = { ...base, orgId: row.org_id, campaignAddress: getAddress(row.onchain_address), status: "open" };
  if (row.beneficiary_type !== "ORGANIZATION" || !row.org_id) return { ...ctx, status: "individual" };

  const start = ratingWindowStart({
    state: row.state, endTime: BigInt(row.end_time), settlementStart: BigInt(row.settlement_start),
    lastRelease: row.last_release === null ? null : BigInt(row.last_release),
  });
  if (start === null) return { ...ctx, status: "not_finished" };
  ctx.windowEndsAt = new Date(Number((start + WINDOW_S) * 1000n));

  const [own] = await db
    .select({ stars: ratings.stars, comment: ratings.comment, updatedAt: ratings.updatedAt })
    .from(ratings)
    .where(and(eq(ratings.campaignId, campaignId), eq(ratings.userId, userId)));
  ctx.rating = own ?? null;

  if (row.own) return { ...ctx, status: "own" };
  if (!row.donor) return { ...ctx, status: "not_donor" };
  if (now.getTime() > ctx.windowEndsAt.getTime()) return { ...ctx, status: "window_closed" };
  return ctx;
}

/** Verifies a typed-data signature for a smart account (ERC-1271 / ERC-6492) on chain. */
export type ContractSignatureVerifier = (input: {
  address: Address;
  signature: Hex;
  typedData: ReturnType<typeof ratingTypedData>;
}) => Promise<boolean>;

/** The chain's own check through the RPC upstreams (viem's universal validator). */
export function chainSignatureVerifier(): ContractSignatureVerifier {
  const appEnv = parseAppEnv(process.env.APP_ENV ?? "local");
  // No `chain`: viem's universal validator is a deployless eth_call.
  const client = createPublicClient({
    transport: fallback(rpcUpstreams(appEnv, process.env.RPC_URL || undefined).map((url) => http(url, { timeout: 10_000 }))),
  });
  return ({ address, signature, typedData }) => client.verifyTypedData({ address, signature, ...typedData });
}

export interface SaveRatingInput {
  stars: number;
  comment?: string | null;
  signer: string;
  issuedAt: number;
  signature: Hex;
}

export type SaveRatingResult =
  | { ok: true; created: boolean }
  | { ok: false; error: RatingStatus | "invalid_request" | "not_your_address" | "stale" | "bad_signature" };

export async function saveRating(
  db: Database,
  input: {
    campaignId: string;
    userId: string;
    rating: SaveRatingInput;
    chainId: number;
    verifyContract: ContractSignatureVerifier;
    ip?: string | null;
    now?: Date;
  }
): Promise<SaveRatingResult> {
  const now = input.now ?? new Date();
  const { stars, signer, issuedAt, signature } = input.rating;
  const comment = normaliseRatingComment(input.rating.comment);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return { ok: false, error: "invalid_request" };
  if (comment !== null && comment.length > RATING_COMMENT_MAX) return { ok: false, error: "invalid_request" };
  if (!isAddress(signer) || !Number.isSafeInteger(issuedAt)) return { ok: false, error: "invalid_request" };
  if (Math.abs(issuedAt - Math.floor(now.getTime() / 1000)) > RATING_ISSUED_AT_TOLERANCE_S) return { ok: false, error: "stale" };

  const ctx = await loadRatingContext(db, input.campaignId, input.userId, now);
  if (ctx.status !== "open") return { ok: false, error: ctx.status };

  const signerLower = signer.toLowerCase();
  const [linked] = await db
    .select({ kind: userAddresses.kind })
    .from(userAddresses)
    .where(and(eq(userAddresses.userId, input.userId), eq(userAddresses.address, signerLower)));
  if (!linked) return { ok: false, error: "not_your_address" };

  const typedData = ratingTypedData(input.chainId, {
    campaign: ctx.campaignAddress!, organization: ctx.orgId!, stars, comment, issuedAt: BigInt(issuedAt),
  });
  let valid = false;
  try {
    valid = isAddressEqual(await recoverTypedDataAddress({ ...typedData, signature }), getAddress(signer));
  } catch {
    valid = false; // not a 65-byte ECDSA signature: maybe a smart account's
  }
  if (!valid && linked.kind === "SMART_ACCOUNT") {
    valid = await input.verifyContract({ address: getAddress(signer), signature, typedData }).catch(() => false);
  }
  if (!valid) return { ok: false, error: "bad_signature" };

  const signedAt = new Date(issuedAt * 1000);
  return db.transaction(async (tx) => {
    // A newer signature replaces the rating; an older one (replayed) does not.
    const [saved] = (await tx.execute(sql`
      insert into app.ratings (id, org_id, campaign_id, user_id, stars, comment, signature, signer_address, signed_at)
      values (${randomUUID()}, ${ctx.orgId}, ${input.campaignId}, ${input.userId}, ${stars}, ${comment}, ${signature}, ${signerLower}, ${signedAt.toISOString()}::timestamptz)
      on conflict (campaign_id, user_id) do update
        set stars = excluded.stars, comment = excluded.comment, signature = excluded.signature,
            signer_address = excluded.signer_address, signed_at = excluded.signed_at, updated_at = now()
        where app.ratings.signed_at is null or app.ratings.signed_at < excluded.signed_at
      returning (xmax = 0) as created
    `)) as unknown as { created: boolean }[];
    if (!saved) return { ok: false, error: "stale" } as const;
    await tx.insert(auditLog).values({
      actorUserId: input.userId, action: "rating.saved", entityType: "campaign", entityId: input.campaignId,
      data: { stars, signer: signerLower, created: saved.created }, ip: input.ip ?? null,
    });
    return { ok: true, created: saved.created } as const;
  });
}

// ── Showing ratings (TASK-057b, ADR-058) ─────────────────────────────────────
// Publicly only the average and the count; the private comments only to the
// organisation's members and to platform admins. Raters are never named.

export interface RatingSummary {
  /** Mean of the stars, 1–5, one decimal place. */
  average: number;
  count: number;
}

/** Average and count per organisation (one query). Organisations without ratings are absent. */
export async function orgRatingSummaries(db: Database, orgIds: string[]): Promise<Map<string, RatingSummary>> {
  const out = new Map<string, RatingSummary>();
  if (orgIds.length === 0) return out;
  const rows = (await db.execute(sql`
    select org_id, round(avg(stars)::numeric, 1)::text as average, count(*)::int as n
    from app.ratings
    where org_id in (${sql.join(orgIds.map((id) => sql`${id}::uuid`), sql`, `)})
    group by org_id
  `)) as unknown as { org_id: string; average: string; n: number }[];
  for (const r of rows) out.set(r.org_id, { average: Number(r.average), count: Number(r.n) });
  return out;
}

export interface RatingEntry {
  stars: number;
  comment: string | null;
  updatedAt: Date;
  campaignTitle: string;
  campaignId: string;
}

/** The latest ratings of an organisation, or of one campaign — for its members and admins only. */
export async function listRatings(
  db: Database,
  filter: { orgId: string } | { campaignId: string },
  limit = 50
): Promise<RatingEntry[]> {
  const where = "orgId" in filter ? sql`r.org_id = ${filter.orgId}` : sql`r.campaign_id = ${filter.campaignId}`;
  const rows = (await db.execute(sql`
    select r.stars, r.comment, r.updated_at, c.title, c.id as campaign_id
    from app.ratings r join app.campaigns c on c.id = r.campaign_id
    where ${where}
    order by r.updated_at desc, r.id
    limit ${limit}
  `)) as unknown as { stars: number; comment: string | null; updated_at: Date | string; title: string; campaign_id: string }[];
  return rows.map((r) => ({
    stars: Number(r.stars), comment: r.comment, updatedAt: new Date(r.updated_at), campaignTitle: r.title, campaignId: r.campaign_id,
  }));
}

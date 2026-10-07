import { randomInt } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { campaignReferrals, campaigns, users, type Database } from "@cherrio/db";
import { REF_COOKIE, isRefCode } from "./referral-cookie";

// Personal share links (ADR-057 §5, TASK-055).
//
// Every signed-in user gets a short code (created on first use). A visitor who
// opens any page with `?ref=<code>` gets the first-touch cookie `cherrio_ref`
// for 30 days (set in middleware.ts; a later link never replaces it). The code
// is then used twice:
//   - at registration: `users.referred_by_user_id` (a friend who joined);
//   - when a signed-in user starts a donation: one `campaign_referrals` row per
//     user and campaign (first touch wins).
// Nothing here awards points: TASK-056 credits only donations the chain
// confirms from the user's linked addresses.

export { REF_COOKIE, REF_COOKIE_MAX_AGE, REF_CODE_PATTERN, isRefCode } from "./referral-cookie";
const CODE_LENGTH = 8;
// No 0/o, 1/l/i: codes are read aloud and typed from screenshots.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function generateRefCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** The `cherrio_ref` value of a request, if it is a well-formed code. */
export function refCodeFromRequest(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === REF_COOKIE) {
      let value: string;
      try {
        value = decodeURIComponent(rest.join("="));
      } catch {
        return null; // a broken cookie must never break a login (review, TASK-055)
      }
      return isRefCode(value) ? value : null;
    }
  }
  return null;
}

/** The user's share code, created on first use (concurrent first uses agree on one code). */
export async function getOrCreateRefCode(db: Database, userId: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [row] = await db.select({ refCode: users.refCode }).from(users).where(eq(users.id, userId));
    if (!row) throw new Error("user not found");
    if (row.refCode) return row.refCode;
    try {
      await db.update(users).set({ refCode: generateRefCode() }).where(and(eq(users.id, userId), isNull(users.refCode)));
    } catch (e) {
      if (!isUniqueViolation(e)) throw e; // another user already has this code: draw again
    }
  }
  throw new Error("could not create a share code");
}

/** The user a code belongs to; null for unknown codes. */
export async function findReferrer(db: Pick<Database, "select">, code: string | null): Promise<string | null> {
  if (!isRefCode(code)) return null;
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.refCode, code));
  return row?.id ?? null;
}

export type RecordReferralResult =
  | { recorded: true }
  | { recorded: false; reason: "no_code" | "unknown_code" | "self" | "unknown_campaign" | "already_recorded" };

/**
 * Remembers who brought `userId` to `campaignAddress` (first touch wins). Safe
 * to call on every donation attempt: a second call for the same user and
 * campaign changes nothing.
 */
export async function recordCampaignReferral(
  db: Database,
  input: { userId: string; campaignAddress: string; code: string | null }
): Promise<RecordReferralResult> {
  if (!isRefCode(input.code)) return { recorded: false, reason: "no_code" };
  const referrerUserId = await findReferrer(db, input.code);
  if (!referrerUserId) return { recorded: false, reason: "unknown_code" };
  if (referrerUserId === input.userId) return { recorded: false, reason: "self" };
  const [campaign] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.onchainAddress, input.campaignAddress.toLowerCase()), eq(campaigns.status, "DEPLOYED")));
  if (!campaign) return { recorded: false, reason: "unknown_campaign" };
  const inserted = await db
    .insert(campaignReferrals)
    .values({ userId: input.userId, campaignId: campaign.id, referrerUserId })
    .onConflictDoNothing()
    .returning({ userId: campaignReferrals.userId });
  return inserted.length > 0 ? { recorded: true } : { recorded: false, reason: "already_recorded" };
}

/** The public campaign URL, with the personal code when there is one. */
export function campaignShareUrl(origin: string, locale: string, slug: string, code?: string | null): string {
  const url = new URL(`/${locale}/campaigns/${encodeURIComponent(slug)}`, origin);
  if (isRefCode(code)) url.searchParams.set("ref", code);
  return url.toString();
}

function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
}

// Exported for tests: rows of a user's referrals (who brought them, per campaign).
export const referralsOf = (db: Database, userId: string) =>
  db.select().from(campaignReferrals).where(eq(campaignReferrals.userId, userId)).orderBy(sql`created_at`);

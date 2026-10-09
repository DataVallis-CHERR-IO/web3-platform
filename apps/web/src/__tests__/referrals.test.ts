import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, or } from "drizzle-orm";
import type { PrivyClient } from "@privy-io/server-auth";
import * as schema from "@cherrio/db";
import { eraseUser } from "@cherrio/db";
import { getDb } from "@/lib/db";
import { setPrivyClientForTesting } from "@/lib/auth/privy";
import { authRateLimiter, referralRateLimiter } from "@/lib/security/rate-limit";
import { POST as sessionPost } from "@/app/api/auth/session/route";
import { GET as getCode } from "@/app/api/me/referral-code/route";
import { POST as postReferral } from "@/app/api/referrals/route";
import {
  REF_COOKIE, campaignShareUrl, findReferrer, generateRefCode, getOrCreateRefCode, isRefCode, recordCampaignReferral, refCodeFromRequest,
} from "@/lib/referrals";
import { firstTouchRefCode } from "@/lib/referral-cookie";
import { SHARE_NETWORKS, withRefCode } from "@/components/campaigns/CampaignShare";
import { ORIGIN, createUser, cleanUp, type TestUser } from "./helpers/organizations";

// TASK-055 (ADR-057 §5): personal share codes, the first-touch cookie and
// who brought a user to a campaign. Real handlers, real Postgres.

const { users, campaigns, campaignReferrals, auditLog, userAddresses } = schema;
const RUN = Date.now().toString(36);
const addr = () => `0x${randomBytes(20).toString("hex")}`;
const campaignIds: string[] = [];
const extraUserIds: string[] = [];
let starter: TestUser;

async function campaign(status: "DEPLOYED" | "APPROVED" = "DEPLOYED") {
  const onchainAddress = status === "DEPLOYED" ? addr() : null;
  const [row] = await getDb()
    .insert(campaigns)
    .values({
      starterUserId: starter.id, beneficiaryType: "INDIVIDUAL", title: `Share ${RUN} ${campaignIds.length}`,
      slug: `share-${RUN}-${campaignIds.length}`, story: { format: "plain", text: "Story. ".repeat(20) }, cause: "animals",
      country: "SI", goalAmountMinor: "1000000", durationDays: 30, status, eurUsdRate: "1.17000000", rateSource: "ECB",
      rateAt: new Date(), targetUsdc: 1_000_000_000n, beneficiaryAddress: addr(), deadline: new Date(), onchainAddress,
    })
    .returning({ id: campaigns.id });
  campaignIds.push(row!.id);
  return { id: row!.id, address: onchainAddress ?? addr() };
}

const withCookie = (cookie: string, code?: string) => (code ? `${cookie}; ${REF_COOKIE}=${code}` : cookie);
const post = (cookie: string, body: unknown, origin = ORIGIN) =>
  postReferral(
    new Request(`${ORIGIN}/api/referrals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie },
      body: JSON.stringify(body),
    })
  );

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("referral tests need DATABASE_URL");
  process.env.APP_ENV = "local";
  process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  starter = await createUser();
});

afterAll(async () => {
  const db = getDb();
  await db.delete(campaignReferrals).where(inArray(campaignReferrals.campaignId, campaignIds));
  await db.delete(campaigns).where(inArray(campaigns.id, campaignIds));
  if (extraUserIds.length > 0) {
    await db.delete(auditLog).where(inArray(auditLog.actorUserId, extraUserIds));
    await db.delete(userAddresses).where(inArray(userAddresses.userId, extraUserIds));
    await db.delete(users).where(inArray(users.id, extraUserIds));
  }
  // Rows that point at helper users (referred_by) go before the helper deletes them.
  await db.update(users).set({ referredByUserId: null }).where(eq(users.referredByUserId, starter.id));
  setPrivyClientForTesting(null);
  await cleanUp();
});

describe("share codes", () => {
  it("are 8 characters without look-alike letters, created once per user, and found again", async () => {
    for (let i = 0; i < 200; i++) expect(generateRefCode()).toMatch(/^[a-hjkmnp-z2-9]{8}$/);
    const u = await createUser();
    const [a, b] = await Promise.all([getOrCreateRefCode(getDb(), u.id), getOrCreateRefCode(getDb(), u.id)]);
    expect(a).toBe(b); // two first uses at once agree
    expect(await getOrCreateRefCode(getDb(), u.id)).toBe(a);
    expect(await findReferrer(getDb(), a)).toBe(u.id);
    expect(await findReferrer(getDb(), "zzzzzzzz")).toBeNull();
    expect(await findReferrer(getDb(), "not a code")).toBeNull();
    expect(isRefCode("abcdefgh")).toBe(true);
    expect(isRefCode("ABCDEFGH")).toBe(false);
    expect(isRefCode("abc")).toBe(false);
  });

  it("GET /api/me/referral-code: 401 without a session, the same code on every call", async () => {
    const anon = await getCode(new Request(`${ORIGIN}/api/me/referral-code`));
    expect(anon.status).toBe(401);
    const u = await createUser();
    const first = await getCode(new Request(`${ORIGIN}/api/me/referral-code`, { headers: { Cookie: u.cookie } }));
    expect(first.status).toBe(200);
    const { code } = (await first.json()) as { code: string };
    expect(isRefCode(code)).toBe(true);
    const again = await getCode(new Request(`${ORIGIN}/api/me/referral-code`, { headers: { Cookie: u.cookie } }));
    expect(((await again.json()) as { code: string }).code).toBe(code);
  });
});

describe("first-touch cookie", () => {
  it("is set only for a well-formed ?ref= and never replaces an earlier one", () => {
    expect(firstTouchRefCode("abcdefgh", undefined)).toBe("abcdefgh");
    expect(firstTouchRefCode(" ABCDEFGH ", undefined)).toBe("abcdefgh");
    expect(firstTouchRefCode("abcdefgh", "zzzzzzzz")).toBeNull(); // first touch wins
    expect(firstTouchRefCode("abcdefgh", "garbage!")).toBe("abcdefgh"); // a broken cookie does not block
    expect(firstTouchRefCode("<script>", undefined)).toBeNull();
    expect(firstTouchRefCode(null, undefined)).toBeNull();
    const req = new Request(ORIGIN, { headers: { Cookie: `a=1; ${REF_COOKIE}=abcdefgh; b=2` } });
    expect(refCodeFromRequest(req)).toBe("abcdefgh");
    expect(refCodeFromRequest(new Request(ORIGIN, { headers: { Cookie: `${REF_COOKIE}=x%3B` } }))).toBeNull();
    // A malformed escape (tampered cookie) is ignored instead of throwing.
    expect(refCodeFromRequest(new Request(ORIGIN, { headers: { Cookie: `${REF_COOKIE}=%E0%A4%A` } }))).toBeNull();
  });
});

describe("POST /api/referrals", () => {
  it("records who brought the user to the campaign — first touch wins, never yourself, only published campaigns", async () => {
    const referrer = await createUser();
    const other = await createUser();
    const donor = await createUser();
    const code = await getOrCreateRefCode(getDb(), referrer.id);
    const otherCode = await getOrCreateRefCode(getDb(), other.id);
    const live = await campaign();
    const approved = await campaign("APPROVED");

    expect(await (await post(withCookie(donor.cookie), { campaign: live.address })).json()).toEqual({ recorded: false, reason: "no_code" });
    expect(await (await post(withCookie(donor.cookie, "zzzzzzzz"), { campaign: live.address })).json()).toEqual({
      recorded: false, reason: "unknown_code",
    });
    expect(await (await post(withCookie(referrer.cookie, code), { campaign: live.address })).json()).toEqual({ recorded: false, reason: "self" });
    expect(await (await post(withCookie(donor.cookie, code), { campaign: approved.address })).json()).toEqual({
      recorded: false, reason: "unknown_campaign",
    });
    // Checksummed address from the wallet is fine.
    const mixed = `0x${live.address.slice(2).toUpperCase()}`;
    expect(await (await post(withCookie(donor.cookie, code), { campaign: mixed })).json()).toEqual({ recorded: true });
    expect(await (await post(withCookie(donor.cookie, otherCode), { campaign: live.address })).json()).toEqual({
      recorded: false, reason: "already_recorded",
    });
    const rows = await getDb().select().from(campaignReferrals).where(eq(campaignReferrals.userId, donor.id));
    expect(rows.map((r) => [r.campaignId, r.referrerUserId])).toEqual([[live.id, referrer.id]]);
  });

  it("refuses without a session, from another origin, with a bad body, and over the rate limit", async () => {
    const u = await createUser();
    const live = await campaign();
    expect((await post("", { campaign: live.address })).status).toBe(401);
    expect((await post(u.cookie, { campaign: live.address }, "https://evil.example")).status).toBe(403);
    expect((await post(u.cookie, { campaign: "0x123" })).status).toBe(400);
    referralRateLimiter.reset();
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await post(u.cookie, { campaign: live.address })).status;
    expect(last).toBe(429);
    referralRateLimiter.reset();
  });

  it("the library refuses the same cases without the HTTP layer", async () => {
    const live = await campaign();
    const u = await createUser();
    expect(await recordCampaignReferral(getDb(), { userId: u.id, campaignAddress: live.address, code: null })).toEqual({
      recorded: false, reason: "no_code",
    });
  });
});

describe("registration through a share link", () => {
  const DID = `did:privy:referred-${RUN}`;
  const login = (cookie: string) =>
    sessionPost(
      new Request(`${ORIGIN}/api/auth/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
        body: JSON.stringify({ accessToken: "fake-token" }),
      })
    );

  it("stores who brought a new user; a later login with another code changes nothing", async () => {
    setPrivyClientForTesting({
      verifyAuthToken: async () => ({ userId: DID }),
      getUser: async () => ({ id: DID, linkedAccounts: [] }),
    } as unknown as PrivyClient);
    authRateLimiter.reset();
    const code = await getOrCreateRefCode(getDb(), starter.id);
    expect((await login(`${REF_COOKIE}=${code}`)).status).toBe(200);
    const [created] = await getDb().select().from(users).where(eq(users.privyDid, DID));
    extraUserIds.push(created!.id);
    expect(created!.referredByUserId).toBe(starter.id);

    const other = await createUser();
    const otherCode = await getOrCreateRefCode(getDb(), other.id);
    expect((await login(`${REF_COOKIE}=${otherCode}`)).status).toBe(200);
    const [again] = await getDb().select().from(users).where(eq(users.privyDid, DID));
    expect(again!.referredByUserId).toBe(starter.id);
  });

  it("an unknown code registers the user without a referrer", async () => {
    const did = `did:privy:unreferred-${RUN}`;
    setPrivyClientForTesting({
      verifyAuthToken: async () => ({ userId: did }),
      getUser: async () => ({ id: did, linkedAccounts: [] }),
    } as unknown as PrivyClient);
    authRateLimiter.reset();
    expect((await login(`${REF_COOKIE}=zzzzzzzz`)).status).toBe(200);
    const [created] = await getDb().select().from(users).where(eq(users.privyDid, did));
    extraUserIds.push(created!.id);
    expect(created!.referredByUserId).toBeNull();
  });
});

describe("erasing a user (GDPR)", () => {
  it("removes their share code, who brought them, and their campaign referrals", async () => {
    const referrer = await createUser();
    const code = await getOrCreateRefCode(getDb(), referrer.id);
    const live = await campaign();
    const [person] = await getDb()
      .insert(users)
      .values({ displayName: `Erase ${RUN}`, referredByUserId: referrer.id })
      .returning({ id: users.id });
    extraUserIds.push(person!.id);
    await getOrCreateRefCode(getDb(), person!.id);
    expect(await recordCampaignReferral(getDb(), { userId: person!.id, campaignAddress: live.address, code })).toEqual({ recorded: true });

    await eraseUser(getDb(), person!.id);
    const [erased] = await getDb().select().from(users).where(eq(users.id, person!.id));
    expect([erased!.refCode, erased!.referredByUserId]).toEqual([null, null]);
    expect(
      await getDb().select().from(campaignReferrals).where(or(eq(campaignReferrals.userId, person!.id)))
    ).toEqual([]);
  });
});

describe("share links", () => {
  it("carry the personal code and are encoded for every network", () => {
    const base = campaignShareUrl("https://dev.cherr.io", "en", "roof-for-the-shelter");
    expect(base).toBe("https://dev.cherr.io/en/campaigns/roof-for-the-shelter");
    expect(campaignShareUrl("https://dev.cherr.io", "en", "roof", "abcdefgh")).toBe("https://dev.cherr.io/en/campaigns/roof?ref=abcdefgh");
    expect(campaignShareUrl("https://dev.cherr.io", "en", "roof", "BAD")).toBe("https://dev.cherr.io/en/campaigns/roof");
    const link = withRefCode(base, "abcdefgh");
    expect(link).toBe(`${base}?ref=abcdefgh`);
    expect(withRefCode(base, null)).toBe(base);
    const text = "Help “Roof” & more";
    for (const n of SHARE_NETWORKS) {
      const href = n.href(link, text);
      expect(href).toContain(encodeURIComponent(link));
      expect(href).not.toContain(" ");
    }
    expect(SHARE_NETWORKS.map((n) => n.key)).toEqual(["x", "facebook", "linkedin", "whatsapp", "telegram", "email"]);
  });
});

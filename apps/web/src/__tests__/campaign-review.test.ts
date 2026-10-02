import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as schema from "@cherrio/db";
import messages from "../../messages/en.json";
import { getDb } from "@/lib/db";
import { POST as approveRoute } from "@/app/api/admin/campaigns/[id]/approve/route";
import { POST as rejectRoute } from "@/app/api/admin/campaigns/[id]/reject/route";
import { PATCH as updateRoute } from "@/app/api/campaigns/[id]/route";
import { POST as submitRoute } from "@/app/api/campaigns/[id]/submit/route";
import { applicationRateLimiter } from "@/lib/security/rate-limit";
import { CAMPAIGN_REVIEW_ERROR_CODES } from "@/lib/campaigns/review-route";
import { cleanUp, createOrganization, createUser, ORIGIN, PAYOUT_ADDRESS, type TestUser } from "./helpers/organizations";

// Integration tests for the campaign review (TASK-010b): real handlers, Postgres,
// and the ECB file served by a local HTTP server (ECB_RATES_URL, APP_ENV=local).

const { campaigns, campaignMedia, auditLog, orgMembers, organizations } = schema;
const NOTE = "Please explain what the money is spent on.";
const FIXTURE = readFileSync(join(__dirname, "fixtures/ecb-eurofxref-daily.xml"), "utf8");
const today = () => new Date().toISOString().slice(0, 10);

/** What the fake ECB answers: the fixture dated today, an error, or a low rate. */
let ecbMode: "ok" | "down" | "low" = "ok";
let ecbRequests = 0;
let ecb: Server;

type Result = { status: number; json: Record<string, unknown> | null };
async function call(route: (req: Request, ctx: never) => Promise<Response>, user: TestUser | null, id: string, body: unknown, origin = ORIGIN): Promise<Result> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: origin };
  if (user) headers.cookie = user.cookie;
  const res = await route(new Request(`${ORIGIN}/api/admin/campaigns/${id}`, { method: "POST", headers, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  } as never);
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}
const approve = (user: TestUser | null, id: string, body: unknown = {}, origin?: string) => call(approveRoute as never, user, id, body, origin);
const reject = (user: TestUser | null, id: string, note = NOTE) => call(rejectRoute as never, user, id, { note });

const campaignRow = async (id: string) => (await getDb().select().from(campaigns).where(eq(campaigns.id, id)))[0]!;
const auditFor = (id: string) => getDb().select().from(auditLog).where(eq(auditLog.entityId, id));

let n = 0;
/** A campaign as the organisation submitted it: PENDING_REVIEW with a cover row. */
async function pendingCampaign(owner: TestUser, orgId: string, targetEur = 12_000): Promise<string> {
  const [row] = await getDb()
    .insert(campaigns)
    .values({
      orgId, starterUserId: owner.id, beneficiaryType: "ORGANIZATION", title: `Review test ${++n}`,
      slug: `review-test-${orgId}-${n}`, story: { format: "plain", text: "x".repeat(60) }, cause: "animals",
      country: "SI", targetEurCents: String(targetEur * 100), durationDays: 30, status: "PENDING_REVIEW",
      submittedAt: new Date(),
    })
    .returning({ id: campaigns.id });
  await getDb().insert(campaignMedia).values({ campaignId: row!.id, kind: "COVER", cid: `campaigns/${row!.id}/test.webp`, storage: "HETZNER_PUBLIC" });
  return row!.id;
}

describe("campaign review — approve with the ECB snapshot, reject (Postgres)", () => {
  let admin: TestUser;
  let owner: TestUser;
  let orgId: string;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("campaign review tests need DATABASE_URL");
    process.env.APP_ENV = "local";
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    await getDb().execute(sql`select 1`);

    ecb = createServer((_req, res) => {
      ecbRequests++;
      if (ecbMode === "down") {
        res.writeHead(500).end("unavailable");
        return;
      }
      const body = FIXTURE.replace("2026-10-01", today()).replace("rate='1.1734'", ecbMode === "low" ? "rate='0.9'" : "rate='1.1734'");
      res.writeHead(200, { "Content-Type": "text/xml" }).end(body);
    });
    await new Promise<void>((resolve) => ecb.listen(0, "127.0.0.1", resolve));
    process.env.ECB_RATES_URL = `http://127.0.0.1:${(ecb.address() as AddressInfo).port}/eurofxref-daily.xml`;

    admin = await createUser({ admin: true });
    owner = await createUser();
    orgId = (await createOrganization(owner)).id;
  });
  beforeEach(() => {
    ecbMode = "ok";
    applicationRateLimiter.reset();
  });
  afterAll(async () => {
    delete process.env.ECB_RATES_URL;
    await new Promise((resolve) => ecb.close(resolve));
    await cleanUp();
  });

  it("approve: APPROVED with the ECB rate, the floor USDC target, the org's payout address and a random 32-byte offchain id", async () => {
    const id = await pendingCampaign(owner, orgId);
    const result = await approve(admin, id);
    // 1,200,000 cents × 1.1734 = 14,080.80 USDC → 14_080_800_000 units
    expect(result).toEqual({
      status: 200,
      json: { campaignId: id, eurUsdRate: "1.17340000", rateAt: today(), targetUsdc: "14080800000" },
    });

    const row = await campaignRow(id);
    expect(row).toMatchObject({
      status: "APPROVED",
      eurUsdRate: "1.17340000",
      rateSource: "ECB",
      targetUsdc: 14_080_800_000n,
      beneficiaryAddress: PAYOUT_ADDRESS.toLowerCase(),
      reviewerId: admin.id,
      reviewNote: null,
    });
    expect(row.rateAt!.toISOString()).toBe(`${today()}T00:00:00.000Z`);
    expect(row.reviewedAt).toBeInstanceOf(Date);
    expect(row.offchainId).toBeInstanceOf(Buffer);
    expect(row.offchainId!.length).toBe(32);

    // A second campaign gets a different offchain id.
    const other = await pendingCampaign(owner, orgId);
    expect((await approve(admin, other)).status).toBe(200);
    expect((await campaignRow(other)).offchainId!.equals(row.offchainId!)).toBe(false);

    const audit = await auditFor(id);
    expect(audit).toMatchObject([{ action: "campaign.approve", actorUserId: admin.id, entityType: "campaign" }]);
    expect(Object.keys(audit[0]!.data as object).sort()).toEqual(
      ["campaignId", "eurUsdRate", "organizationId", "rateAt", "rateSource", "targetUsdc"]
    );

    // Decided once: a second approval or a rejection is refused.
    expect(await approve(admin, id)).toEqual({ status: 409, json: { error: "not_pending" } });
    expect(await reject(admin, id)).toEqual({ status: 409, json: { error: "not_pending" } });
  });

  it("reject with a note → REJECTED; the organisation edits and resubmits; then it can be approved", async () => {
    const id = await pendingCampaign(owner, orgId);
    expect(await reject(admin, id)).toEqual({ status: 200, json: { campaignId: id } });
    expect(await campaignRow(id)).toMatchObject({ status: "REJECTED", reviewNote: NOTE, reviewerId: admin.id, targetUsdc: null, offchainId: null });
    const audit = await auditFor(id);
    expect(audit).toMatchObject([{ action: "campaign.reject" }]);
    expect(JSON.stringify(audit[0]!.data)).not.toContain(NOTE.slice(0, 20)); // the note is not copied

    const headers = { "Content-Type": "application/json", Origin: ORIGIN, cookie: owner.cookie };
    const edit = await updateRoute(
      new Request(`${ORIGIN}/api/campaigns/${id}`, {
        method: "PATCH", headers,
        body: JSON.stringify({ title: "Review test, with details", story: "y".repeat(80), cause: "animals", country: "SI", targetEur: 15_000, durationDays: 45 }),
      }),
      { params: Promise.resolve({ id }) }
    );
    expect(edit.status).toBe(200);
    const again = await submitRoute(new Request(`${ORIGIN}/api/campaigns/${id}/submit`, { method: "POST", headers }), { params: Promise.resolve({ id }) });
    expect(again.status).toBe(200);
    expect((await campaignRow(id)).status).toBe("PENDING_REVIEW");

    const approved = await approve(admin, id);
    expect(approved.json).toMatchObject({ targetUsdc: "17601000000" }); // 15,000 × 1.1734
    expect(await campaignRow(id)).toMatchObject({ status: "APPROVED", reviewNote: null });
  });

  it("no ECB rate → 503 rate_unavailable and nothing written; a decided campaign never asks the ECB", async () => {
    const id = await pendingCampaign(owner, orgId);
    ecbMode = "down";
    expect(await approve(admin, id)).toEqual({ status: 503, json: { error: "rate_unavailable" } });

    const saved = process.env.ECB_RATES_URL;
    process.env.ECB_RATES_URL = "http://127.0.0.1:1/unreachable.xml";
    try {
      expect(await approve(admin, id)).toEqual({ status: 503, json: { error: "rate_unavailable" } });
    } finally {
      process.env.ECB_RATES_URL = saved;
    }
    expect(await campaignRow(id)).toMatchObject({ status: "PENDING_REVIEW", eurUsdRate: null, targetUsdc: null, offchainId: null, beneficiaryAddress: null });
    expect(await auditFor(id)).toEqual([]);

    ecbMode = "ok";
    await reject(admin, id);
    const before = ecbRequests;
    expect(await approve(admin, id)).toEqual({ status: 409, json: { error: "not_pending" } });
    expect(ecbRequests).toBe(before);
  });

  it("a target under 100 USDC at the day's rate is refused (contract minimum)", async () => {
    const id = await pendingCampaign(owner, orgId, 100);
    ecbMode = "low"; // 100 EUR × 0.9 = 90 USDC
    expect(await approve(admin, id)).toEqual({ status: 409, json: { error: "target_below_minimum" } });
    expect(await campaignRow(id)).toMatchObject({ status: "PENDING_REVIEW", targetUsdc: null });
    ecbMode = "ok"; // 100 EUR × 1.1734 = 117.34 USDC
    expect((await approve(admin, id)).json).toMatchObject({ targetUsdc: "117340000" });
  });

  it("a reviewer who belongs to the organisation is refused, in any role", async () => {
    const id = await pendingCampaign(owner, orgId);
    const memberAdmin = await createUser({ admin: true });
    await getDb().insert(orgMembers).values({ orgId, userId: memberAdmin.id, role: "ORG_MEMBER" });
    expect(await approve(memberAdmin, id)).toEqual({ status: 409, json: { error: "self_review" } });
    expect(await reject(memberAdmin, id)).toEqual({ status: 409, json: { error: "self_review" } });
    expect((await campaignRow(id)).status).toBe("PENDING_REVIEW");
  });

  it("an organisation that is no longer verified cannot get a campaign approved", async () => {
    const otherOwner = await createUser();
    const org = await createOrganization(otherOwner);
    const id = await pendingCampaign(otherOwner, org.id);
    await getDb().update(organizations).set({ kybStatus: "REJECTED" }).where(eq(organizations.id, org.id));
    expect(await approve(admin, id)).toEqual({ status: 409, json: { error: "organization_not_approved" } });
    expect((await campaignRow(id)).status).toBe("PENDING_REVIEW");
  });

  it("everyone but a platform admin gets 404; origin, input and unknown ids are checked", async () => {
    const id = await pendingCampaign(owner, orgId);
    const stranger = await createUser();
    expect(await approve(null, id)).toEqual({ status: 404, json: null });
    expect(await approve(stranger, id)).toEqual({ status: 404, json: null });
    expect(await approve(owner, id)).toEqual({ status: 404, json: null });
    expect(await reject(stranger, id)).toEqual({ status: 404, json: null });
    expect(await approve(admin, id, {}, "https://evil.example")).toEqual({ status: 403, json: { error: "forbidden" } });
    expect(await approve(admin, id, { eurUsdRate: "2.0" })).toEqual({ status: 400, json: { error: "validation_failed" } });
    expect(await reject(admin, id, "too short")).toEqual({ status: 400, json: { error: "validation_failed" } });
    expect(await approve(admin, "not-a-uuid")).toEqual({ status: 404, json: null });
    expect(await approve(admin, "01890000-0000-7000-8000-000000000000")).toEqual({ status: 404, json: null });
    expect(await campaignRow(id)).toMatchObject({ status: "PENDING_REVIEW", reviewerId: null });

    // A draft was never submitted: there is nothing to decide.
    await getDb().update(campaigns).set({ status: "DRAFT", submittedAt: null }).where(eq(campaigns.id, id));
    expect(await approve(admin, id)).toEqual({ status: 409, json: { error: "not_pending" } });
  });

  it("every error code has a message", () => {
    const texts = messages.admin.campaigns.errors as Record<string, string>;
    for (const code of CAMPAIGN_REVIEW_ERROR_CODES) expect(texts[code], code).toBeTruthy();
  });
});

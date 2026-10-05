import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { MIN_CAMPAIGN_TARGET_USDC } from "@cherrio/shared";
import { getDb } from "@/lib/db";
import { POST as demoRoute } from "@/app/api/admin/demo-campaigns/route";
import {
  DEMO_BATCH_MAX,
  DEMO_MIXED_DURATIONS,
  DemoRefusedError,
  LEGACY_DEMO_ORG_NAME,
  createDemoCampaigns,
  demoCampaignsAllowed,
  demoDuration,
  demoOrgSeed,
  demoRequestSchema,
  demoSeed,
  pickSeedIndexes,
  type DemoRequest,
} from "@/lib/demo/create";
import { DEMO_ORG_POOL } from "@/lib/demo/orgs";
import { DEMO_POOL } from "@/lib/demo/pool";
import type { EcbRate } from "@/lib/campaigns/ecb";
import { preparePublish, type PublishDeployment } from "@/lib/campaigns/publish";
import { approveCampaign } from "@/lib/campaigns/review";
import { cleanUp, createUser, ORIGIN, PAYOUT_ADDRESS, type TestUser } from "./helpers/organizations";
import { deleteDemoOrganizations } from "./helpers/demo";

// TASK-038a / TASK-040a (ADR-052, ADR-053): demo organisations and campaigns in
// the production flow. Real handlers, real Postgres; the ECB file comes from a
// local HTTP server (as in campaign-review.test.ts).

const { auditLog, campaigns, kybSubmissions, organizations, orgMembers, users } = schema;
const FIXTURE = readFileSync(join(__dirname, "fixtures/ecb-eurofxref-daily.xml"), "utf8");
const today = () => new Date().toISOString().slice(0, 10);
const rate = async (): Promise<EcbRate> => ({ rate: 117_340_000n as EcbRate["rate"], text: "1.1734", date: new Date() });
const DEPLOYMENT: PublishDeployment = {
  chainId: 80002,
  factory: "0xd5Ca76A8FC6E15C6cC3F3C691A2b6c70D9715a00",
  implementation: "0x6F6A9F54cC48a13bC5bFc127d16D874D07ccEA8F",
  platformConfig: "0x4d2570ccB2a6653D62a002027C0d383FfB193A16",
};
const request = (over: Partial<DemoRequest> = {}): DemoRequest => ({
  newOrganizations: 1, campaignsPerOrganization: 1, state: "APPROVED", payoutAddress: PAYOUT_ADDRESS, durationMode: "mixed", ...over,
});

describe("demo campaign rules", () => {
  it("allows only local and dev", () => {
    expect(demoCampaignsAllowed("local")).toBe(true);
    expect(demoCampaignsAllowed("dev")).toBe(true);
    expect(demoCampaignsAllowed("uat")).toBe(false);
    expect(demoCampaignsAllowed("prod")).toBe(false);
    expect(demoCampaignsAllowed(undefined)).toBe(false);
  });

  it("limits new organisations to 0–5 and campaigns per organisation to the 5 active ones, and needs a wallet address", () => {
    const ok = { newOrganizations: 2, campaignsPerOrganization: 5, state: "APPROVED", payoutAddress: PAYOUT_ADDRESS, durationMode: "mixed" };
    expect(DEMO_BATCH_MAX).toBe(10);
    expect(demoRequestSchema.safeParse(ok).success).toBe(true);
    expect(demoRequestSchema.safeParse({ ...ok, newOrganizations: 0 }).success).toBe(true);
    expect(demoRequestSchema.safeParse({ ...ok, newOrganizations: 6 }).success).toBe(false);
    expect(demoRequestSchema.safeParse({ ...ok, campaignsPerOrganization: 6 }).success).toBe(false);
    expect(demoRequestSchema.safeParse({ ...ok, campaignsPerOrganization: 0 }).success).toBe(false);
    expect(demoRequestSchema.safeParse({ ...ok, state: "DEPLOYED" }).success).toBe(false);
    expect(demoRequestSchema.safeParse({ ...ok, payoutAddress: "0x123" }).success).toBe(false);
    expect(demoRequestSchema.safeParse({ ...ok, durationMode: "long" }).success).toBe(false);
    expect(demoRequestSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  it("uses one day for short mode and cycles 1–30 days for mixed (contract range 1–90)", () => {
    expect(demoDuration("short", 7)).toBe(1);
    expect(DEMO_MIXED_DURATIONS.map((_, i) => demoDuration("mixed", i))).toEqual([1, 3, 7, 14, 21, 30]);
    expect(demoDuration("mixed", DEMO_MIXED_DURATIONS.length)).toBe(1);
  });

  it("picks campaigns that match the organisation's causes first, then any", () => {
    const taken = new Set<number>();
    const animals = pickSeedIndexes(["animals"], 0, 3, taken);
    expect(animals.map((n) => DEMO_POOL[n % DEMO_POOL.length]!.cause)).toEqual(["animals", "animals", "animals"]);
    const again = pickSeedIndexes(["animals"], 0, 2, taken);
    expect(again.some((n) => animals.includes(n))).toBe(false);
    const many = pickSeedIndexes(["animals"], 0, 30, new Set());
    expect(many).toHaveLength(30); // the pool has fewer animal campaigns; any cause fills up
    expect(demoOrgSeed(DEMO_ORG_POOL.length).name).toBe(`${DEMO_ORG_POOL[0]!.name} (2)`);
  });

  it("walks the pool and numbers later rounds", () => {
    expect(demoSeed(0).title).toBe(DEMO_POOL[0]!.title);
    expect(demoSeed(DEMO_POOL.length).title).toBe(`${DEMO_POOL[0]!.title} (2)`);
    expect(demoSeed(2 * DEMO_POOL.length + 1).title).toBe(`${DEMO_POOL[1]!.title} (3)`);
  });

  it("has a pool of valid campaigns (≥ 50, unique titles, every target above the contract minimum)", () => {
    expect(DEMO_POOL.length).toBeGreaterThanOrEqual(50);
    expect(new Set(DEMO_POOL.map((s) => s.title)).size).toBe(DEMO_POOL.length);
    for (const seed of DEMO_POOL) {
      expect(seed.title.length).toBeGreaterThanOrEqual(5);
      expect(seed.title.length).toBeLessThanOrEqual(110); // room for " (n)"
      expect(seed.story.join("\n\n").length).toBeGreaterThanOrEqual(50);
      // 100 € at a low 1.0 rate is still ≥ 100 USDC; the pool starts at 3,000 €.
      expect(BigInt(seed.targetEur) * 1_000_000n).toBeGreaterThan(MIN_CAMPAIGN_TARGET_USDC);
    }
  });
});

describe("createDemoCampaigns (Postgres)", () => {
  let admin: TestUser;
  let stranger: TestUser;
  let ecb: Server;
  const orgIds = new Set<string>();
  const track = (ids: string[]) => ids.forEach((id) => orgIds.add(id));

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("demo campaign tests need DATABASE_URL");
    process.env.APP_ENV = "local";
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    ecb = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/xml" }).end(FIXTURE.replace("2026-10-01", today()));
    });
    await new Promise<void>((resolve) => ecb.listen(0, "127.0.0.1", resolve));
    process.env.ECB_RATES_URL = `http://127.0.0.1:${(ecb.address() as AddressInfo).port}/eurofxref-daily.xml`;
    admin = await createUser({ admin: true });
    stranger = await createUser();
  });

  afterAll(async () => {
    delete process.env.ECB_RATES_URL;
    await new Promise<void>((resolve) => ecb.close(() => resolve()));
    await deleteDemoOrganizations(getDb(), [...orgIds]);
    await cleanUp();
  });

  it("refuses on uat and prod and a batch over 10 campaigns, before touching the database", async () => {
    for (const appEnv of ["uat", "prod"]) {
      await expect(createDemoCampaigns(getDb(), admin.id, request(), { appEnv, getRate: rate })).rejects.toEqual(new DemoRefusedError("not_allowed"));
    }
    await expect(
      createDemoCampaigns(getDb(), admin.id, request({ newOrganizations: 3, campaignsPerOrganization: 4 }), { appEnv: "dev", getRate: rate })
    ).rejects.toEqual(new DemoRefusedError("batch_too_large"));
  });

  it("creates demo organisations whose own member starts the campaigns; the admin can publish them (four eyes intact)", async () => {
    const result = await createDemoCampaigns(getDb(), admin.id, request({ newOrganizations: 2, campaignsPerOrganization: 2 }), { appEnv: "dev", getRate: rate });
    track(result.organizationIds);
    expect(result.organizationIds).toHaveLength(2);
    expect(result.created).toHaveLength(4);

    for (const orgId of result.organizationIds) {
      const [org] = await getDb().select().from(organizations).where(eq(organizations.id, orgId));
      expect(org!.isDemo).toBe(true);
      expect(org!.kybStatus).toBe("APPROVED");
      expect(org!.payoutAddress).toBe(PAYOUT_ADDRESS.toLowerCase());
      expect(DEMO_ORG_POOL.some((s) => org!.name.startsWith(s.name))).toBe(true);
      const members = await getDb()
        .select({ userId: orgMembers.userId, role: orgMembers.role, isDemo: users.isDemo, privyDid: users.privyDid })
        .from(orgMembers)
        .innerJoin(users, eq(users.id, orgMembers.userId))
        .where(eq(orgMembers.orgId, orgId));
      expect(members).toHaveLength(1);
      expect(members[0]).toMatchObject({ role: "ORG_ADMIN", isDemo: true, privyDid: null });
      const [kyb] = await getDb().select().from(kybSubmissions).where(eq(kybSubmissions.orgId, orgId));
      expect(kyb).toMatchObject({ status: "APPROVED", reviewerId: admin.id, submittedBy: members[0]!.userId });

      const own = await getDb().select().from(campaigns).where(eq(campaigns.orgId, orgId));
      expect(own).toHaveLength(2);
      for (const row of own) {
        expect(row.isDemo).toBe(true);
        expect(row.status).toBe("APPROVED");
        expect(row.starterUserId).toBe(members[0]!.userId);
        expect(row.reviewerId).toBe(admin.id);
        expect(row.eurUsdRate).toBe("1.17340000");
        expect(row.offchainId).toHaveLength(32);
        expect(row.targetUsdc).toBe((BigInt(row.targetEurCents) * 117_340_000n) / 10_000n);
      }
    }
    // The admin is no member of any demo organisation.
    expect(await getDb().select().from(orgMembers).where(and(eq(orgMembers.userId, admin.id), inArray(orgMembers.orgId, result.organizationIds)))).toHaveLength(0);

    // David's bug of 2026-10-05: publishing a demo campaign was refused "self_review". Now it prepares.
    const prepared = await preparePublish(getDb(), admin.id, result.created[0]!.id, DEPLOYMENT);
    expect(prepared.params.beneficiary.toLowerCase()).toBe(PAYOUT_ADDRESS.toLowerCase());
  });

  it("can send campaigns to review instead; the admin approves them like real ones", async () => {
    const result = await createDemoCampaigns(getDb(), admin.id, request({ state: "PENDING_REVIEW" }), { appEnv: "dev" });
    track(result.organizationIds);
    const [row] = await getDb().select().from(campaigns).where(eq(campaigns.id, result.created[0]!.id));
    expect(row).toMatchObject({ status: "PENDING_REVIEW", eurUsdRate: null, targetUsdc: null, offchainId: null, reviewerId: null });
    const approved = await approveCampaign(getDb(), admin.id, row!.id, { getRate: rate });
    expect(approved.eurUsdRate).toBe("1.17340000");
    const [after] = await getDb().select().from(campaigns).where(eq(campaigns.id, row!.id));
    expect(after!.status).toBe("APPROVED");
    expect(after!.beneficiaryAddress).toBe(PAYOUT_ADDRESS.toLowerCase());
  });

  it("with 0 new organisations adds campaigns to existing demo organisations, never over 5 active each", async () => {
    const first = await createDemoCampaigns(getDb(), admin.id, request({ campaignsPerOrganization: 4 }), { appEnv: "dev", getRate: rate });
    track(first.organizationIds);
    const more = await createDemoCampaigns(getDb(), admin.id, request({ newOrganizations: 0, campaignsPerOrganization: 5 }), { appEnv: "dev", getRate: rate });
    track(more.organizationIds);
    expect(more.created.length).toBeGreaterThan(0);
    expect(more.created.length).toBeLessThanOrEqual(DEMO_BATCH_MAX);
    for (const orgId of more.organizationIds) {
      const [org] = await getDb().select({ isDemo: organizations.isDemo }).from(organizations).where(eq(organizations.id, orgId));
      expect(org!.isDemo).toBe(true);
      const active = await getDb()
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(and(eq(campaigns.orgId, orgId), inArray(campaigns.status, ["PENDING_REVIEW", "APPROVED", "DEPLOYED"])));
      expect(active.length).toBeLessThanOrEqual(5);
    }
    // The organisation of the first batch had 4; it got at most 1 more.
    expect(more.created.filter((c) => c.organizationId === first.organizationIds[0]).length).toBeLessThanOrEqual(1);
  });

  it("repairs the ADR-052 “CHERR.IO Demo” organisation: the admin leaves it, a demo member starts its campaigns", async () => {
    const db = getDb();
    const [legacy] = await db
      .insert(organizations)
      .values({ source: "REGISTERED", name: LEGACY_DEMO_ORG_NAME, country: "SI", registry: "NONE", causes: ["community"], kybStatus: "APPROVED", payoutAddress: PAYOUT_ADDRESS.toLowerCase() })
      .returning({ id: organizations.id });
    track([legacy!.id]);
    await db.insert(orgMembers).values({ orgId: legacy!.id, userId: admin.id, role: "ORG_ADMIN" });
    const [old] = await db
      .insert(campaigns)
      .values({
        orgId: legacy!.id, starterUserId: admin.id, beneficiaryType: "ORGANIZATION", title: "Legacy demo", slug: `legacy-demo-${Date.now()}`,
        story: { format: "plain", text: "x".repeat(60) }, cause: "community", country: "SI", targetEurCents: "100000", durationDays: 1,
        status: "PENDING_REVIEW", isDemo: true,
      })
      .returning({ id: campaigns.id });

    const result = await createDemoCampaigns(db, admin.id, request(), { appEnv: "dev", getRate: rate });
    track(result.organizationIds);

    const [org] = await db.select().from(organizations).where(eq(organizations.id, legacy!.id));
    expect(org!.isDemo).toBe(true);
    const members = await db
      .select({ userId: orgMembers.userId, isDemo: users.isDemo })
      .from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.userId))
      .where(eq(orgMembers.orgId, legacy!.id));
    expect(members).toHaveLength(1);
    expect(members[0]!.isDemo).toBe(true);
    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, old!.id));
    expect(campaign!.starterUserId).toBe(members[0]!.userId);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorUserId, admin.id), eq(auditLog.action, "demo.campaigns_created"), inArray(auditLog.entityId, result.organizationIds)));
    expect((audit!.data as { repairedLegacy: { removedMembers: number } }).repairedLegacy.removedMembers).toBe(1);
    // Approving it is now allowed (the admin is no longer a member, nor its starter).
    expect((await approveCampaign(db, admin.id, old!.id, { getRate: rate })).eurUsdRate).toBe("1.17340000");
  });

  async function post(user: TestUser | null, body: unknown, origin = ORIGIN) {
    const headers: Record<string, string> = { "Content-Type": "application/json", Origin: origin };
    if (user) headers.cookie = user.cookie;
    const res = await demoRoute(new Request(`${ORIGIN}/api/admin/demo-campaigns`, { method: "POST", headers, body: JSON.stringify(body) }));
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  }

  it("POST /api/admin/demo-campaigns: 404 for non-admins and on prod, 403 cross-site, 400 invalid, 409 over 10, 201 for an admin", async () => {
    const body = request({ newOrganizations: 1, campaignsPerOrganization: 2 });
    expect((await post(null, body)).status).toBe(404);
    expect((await post(stranger, body)).status).toBe(404);
    expect((await post(admin, body, "https://evil.example")).status).toBe(403);
    expect((await post(admin, { ...body, campaignsPerOrganization: 6 })).status).toBe(400);
    const tooMany = await post(admin, { ...body, newOrganizations: 5, campaignsPerOrganization: 3 });
    expect(tooMany).toEqual({ status: 409, json: { error: "batch_too_large" } });

    process.env.APP_ENV = "prod";
    try {
      expect((await post(admin, body)).status).toBe(404);
    } finally {
      process.env.APP_ENV = "local";
    }

    const ok = await post(admin, body);
    expect(ok.status).toBe(201);
    track(ok.json!.organizationIds as string[]);
    expect((ok.json!.created as unknown[]).length).toBe(2);
  });
});

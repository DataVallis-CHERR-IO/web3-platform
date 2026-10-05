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
  DEMO_ORG_NAME,
  DemoRefusedError,
  createDemoCampaigns,
  demoCampaignsAllowed,
  demoDuration,
  demoRequestSchema,
  demoSeed,
} from "@/lib/demo/create";
import { DEMO_POOL } from "@/lib/demo/pool";
import type { EcbRate } from "@/lib/campaigns/ecb";
import { cleanUp, createUser, ORIGIN, PAYOUT_ADDRESS, type TestUser } from "./helpers/organizations";

// TASK-038a / ADR-052: demo campaigns. Real handlers, real Postgres; the ECB
// file comes from a local HTTP server (as in campaign-review.test.ts).

const { auditLog, campaigns, organizations, orgMembers } = schema;
const FIXTURE = readFileSync(join(__dirname, "fixtures/ecb-eurofxref-daily.xml"), "utf8");
const today = () => new Date().toISOString().slice(0, 10);
const rate = async (): Promise<EcbRate> => ({ rate: 117_340_000n as EcbRate["rate"], text: "1.1734", date: new Date() });

describe("demo campaign rules", () => {
  it("allows only local and dev", () => {
    expect(demoCampaignsAllowed("local")).toBe(true);
    expect(demoCampaignsAllowed("dev")).toBe(true);
    expect(demoCampaignsAllowed("uat")).toBe(false);
    expect(demoCampaignsAllowed("prod")).toBe(false);
    expect(demoCampaignsAllowed(undefined)).toBe(false);
  });

  it("limits a batch to 1–10 and needs a wallet address", () => {
    const ok = { count: 10, payoutAddress: PAYOUT_ADDRESS, durationMode: "mixed" };
    expect(DEMO_BATCH_MAX).toBe(10);
    expect(demoRequestSchema.safeParse(ok).success).toBe(true);
    expect(demoRequestSchema.safeParse({ ...ok, count: 11 }).success).toBe(false);
    expect(demoRequestSchema.safeParse({ ...ok, count: 0 }).success).toBe(false);
    expect(demoRequestSchema.safeParse({ ...ok, count: 2.5 }).success).toBe(false);
    expect(demoRequestSchema.safeParse({ ...ok, payoutAddress: "0x123" }).success).toBe(false);
    expect(demoRequestSchema.safeParse({ ...ok, durationMode: "long" }).success).toBe(false);
    expect(demoRequestSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  it("uses one day for short mode and cycles 1–30 days for mixed (contract range 1–90)", () => {
    expect(demoDuration("short", 7)).toBe(1);
    expect(DEMO_MIXED_DURATIONS.map((_, i) => demoDuration("mixed", i))).toEqual([1, 3, 7, 14, 21, 30]);
    expect(demoDuration("mixed", DEMO_MIXED_DURATIONS.length)).toBe(1);
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
  let demoOrgExisted = false;
  let ecb: Server;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("demo campaign tests need DATABASE_URL");
    process.env.APP_ENV = "local";
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    ecb = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/xml" }).end(FIXTURE.replace("2026-10-01", today()));
    });
    await new Promise<void>((resolve) => ecb.listen(0, "127.0.0.1", resolve));
    process.env.ECB_RATES_URL = `http://127.0.0.1:${(ecb.address() as AddressInfo).port}/eurofxref-daily.xml`;
    demoOrgExisted = (await getDb().select().from(organizations).where(eq(organizations.name, DEMO_ORG_NAME))).length > 0;
    admin = await createUser({ admin: true });
    stranger = await createUser();
  });

  afterAll(async () => {
    delete process.env.ECB_RATES_URL;
    await new Promise<void>((resolve) => ecb.close(() => resolve()));
    const db = getDb();
    const mine = await db.select({ id: campaigns.id }).from(campaigns).where(and(eq(campaigns.isDemo, true), eq(campaigns.starterUserId, admin.id)));
    if (mine.length > 0) await db.delete(campaigns).where(inArray(campaigns.id, mine.map((c) => c.id)));
    const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, DEMO_ORG_NAME));
    if (org) {
      await db.delete(orgMembers).where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, admin.id)));
      // Only remove the demo organisation if this test created it (a developer's local data stays).
      if (!demoOrgExisted) {
        await db.delete(auditLog).where(eq(auditLog.entityId, org.id));
        await db.delete(organizations).where(eq(organizations.id, org.id));
      }
    }
    await cleanUp();
  });

  it("refuses on uat and prod before touching the database", async () => {
    for (const appEnv of ["uat", "prod"]) {
      await expect(
        createDemoCampaigns(getDb(), admin.id, { count: 1, payoutAddress: PAYOUT_ADDRESS, durationMode: "short" }, { appEnv, getRate: rate })
      ).rejects.toEqual(new DemoRefusedError("not_allowed"));
    }
  });

  it("creates APPROVED demo campaigns under the demo organisation, with a rate snapshot and the admin's payout wallet", async () => {
    const before = (await getDb().select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.isDemo, true))).length;
    const result = await createDemoCampaigns(
      getDb(), admin.id, { count: 3, payoutAddress: PAYOUT_ADDRESS, durationMode: "mixed" }, { appEnv: "dev", getRate: rate }
    );
    expect(result.created).toHaveLength(3);
    const rows = await getDb().select().from(campaigns).where(inArray(campaigns.id, result.created.map((c) => c.id)));
    for (const row of rows) {
      expect(row.isDemo).toBe(true);
      expect(row.status).toBe("APPROVED");
      expect(row.orgId).toBe(result.organizationId);
      expect(row.beneficiaryAddress).toBe(PAYOUT_ADDRESS.toLowerCase());
      expect(row.eurUsdRate).toBe("1.17340000");
      expect(row.rateSource).toBe("ECB");
      expect(row.offchainId).toHaveLength(32);
      expect(row.targetUsdc).toBe((BigInt(row.targetEurCents) * 117_340_000n) / 10_000n);
      expect(row.slug).toMatch(/-demo-[0-9a-f]{6}$/);
    }
    // Pool order continues after the demo campaigns that already exist.
    expect(result.created.map((c) => c.title)).toEqual([0, 1, 2].map((i) => demoSeed(before + i).title));
    expect(result.created.map((c) => c.durationDays)).toEqual([0, 1, 2].map((i) => demoDuration("mixed", before + i)));

    const [org] = await getDb().select().from(organizations).where(eq(organizations.id, result.organizationId));
    expect(org!.name).toBe(DEMO_ORG_NAME);
    expect(org!.kybStatus).toBe("APPROVED");
    const members = await getDb().select().from(orgMembers).where(and(eq(orgMembers.orgId, org!.id), eq(orgMembers.userId, admin.id)));
    expect(members).toHaveLength(1);
    const [audit] = await getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorUserId, admin.id), eq(auditLog.action, "demo.campaigns_created")));
    expect((audit!.data as { count: number }).count).toBe(3);

    // A second batch reuses the organisation and the membership.
    const again = await createDemoCampaigns(
      getDb(), admin.id, { count: 1, payoutAddress: PAYOUT_ADDRESS, durationMode: "short" }, { appEnv: "dev", getRate: rate }
    );
    expect(again.organizationId).toBe(result.organizationId);
    expect(again.created[0]!.durationDays).toBe(1);
    expect(again.created[0]!.title).toBe(demoSeed(before + 3).title);
    expect(await getDb().select().from(orgMembers).where(and(eq(orgMembers.orgId, org!.id), eq(orgMembers.userId, admin.id)))).toHaveLength(1);
  });

  async function post(user: TestUser | null, body: unknown, origin = ORIGIN) {
    const headers: Record<string, string> = { "Content-Type": "application/json", Origin: origin };
    if (user) headers.cookie = user.cookie;
    const res = await demoRoute(new Request(`${ORIGIN}/api/admin/demo-campaigns`, { method: "POST", headers, body: JSON.stringify(body) }));
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  }

  it("POST /api/admin/demo-campaigns: 404 for non-admins and on prod, 403 cross-site, 400 over the limit, 201 for an admin", async () => {
    const body = { count: 2, payoutAddress: PAYOUT_ADDRESS, durationMode: "mixed" };
    expect((await post(null, body)).status).toBe(404);
    expect((await post(stranger, body)).status).toBe(404);
    expect((await post(admin, body, "https://evil.example")).status).toBe(403);
    expect((await post(admin, { ...body, count: 11 })).status).toBe(400);

    process.env.APP_ENV = "prod";
    try {
      expect((await post(admin, body)).status).toBe(404);
    } finally {
      process.env.APP_ENV = "local";
    }

    const ok = await post(admin, body);
    expect(ok.status).toBe(201);
    expect((ok.json!.created as unknown[]).length).toBe(2);
  });
});

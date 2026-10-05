import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { getDb } from "@/lib/db";
import { createDemoCampaigns, DEMO_ORG_NAME } from "@/lib/demo/create";
import { DemoCoverError, FAL_QUEUE, demoCoverPrompt, finishDemoCover, sceneForTitle, startDemoCover } from "@/lib/demo/cover";
import { DEMO_POOL } from "@/lib/demo/pool";
import type { EcbRate } from "@/lib/campaigns/ecb";
import { generateCover, generateCovers } from "@/app/[locale]/admin/demo/covers";
import { cleanUp, createUser, PAYOUT_ADDRESS, type TestUser } from "./helpers/organizations";

// TASK-038b: demo covers through fal.ai's queue API. fal is a fake fetch; the
// image goes through the real sharp re-encoding; the store is an in-memory map.

const { auditLog, campaignMedia, campaigns, organizations, orgMembers } = schema;
const REQUEST_ID = "764cabcf-b745-4b3e-ae38-1200304cf45b";
const KEY = "fal-test-key";
const rate = async (): Promise<EcbRate> => ({ rate: 117_340_000n as EcbRate["rate"], text: "1.1734", date: new Date() });

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

function fakeFal(jpeg: Buffer, script: { statuses?: string[]; submitStatus?: number } = {}) {
  const calls: Call[] = [];
  const statuses = [...(script.statuses ?? ["COMPLETED"])];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? "GET", auth: headers.get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === FAL_QUEUE && init?.method === "POST") {
      if (script.submitStatus) return new Response("nope", { status: script.submitStatus });
      return Response.json({ request_id: REQUEST_ID });
    }
    if (url === `${FAL_QUEUE}/requests/${REQUEST_ID}/status`) return Response.json({ status: statuses.shift() ?? "COMPLETED" });
    if (url === `${FAL_QUEUE}/requests/${REQUEST_ID}`) return Response.json({ images: [{ url: "https://v3.fal.media/files/demo.jpg" }] });
    if (url === "https://v3.fal.media/files/demo.jpg") return new Response(new Uint8Array(jpeg), { headers: { "content-type": "image/jpeg" } });
    return new Response("unexpected", { status: 599 });
  }) as typeof fetch;
  return { calls, impl };
}

describe("demo cover prompt", () => {
  it("finds the pool scene for a title, also for later rounds", () => {
    expect(sceneForTitle(DEMO_POOL[3]!.title)).toBe(DEMO_POOL[3]!.scene);
    expect(sceneForTitle(`${DEMO_POOL[3]!.title} (2)`)).toBe(DEMO_POOL[3]!.scene);
  });

  it("asks for a photo without text, logos or identifiable faces", () => {
    const prompt = demoCoverPrompt("a dog shelter");
    expect(prompt).toContain("a dog shelter");
    expect(prompt).toMatch(/No text/);
    expect(prompt).toMatch(/no logos/);
    expect(prompt).toMatch(/no identifiable faces/);
  });
});

describe("demo covers (Postgres)", () => {
  let admin: TestUser;
  let jpeg: Buffer;
  let ids: string[] = [];
  let demoOrgExisted = false;
  const store = new Map<string, Buffer>();
  const put = async (key: string, webp: Buffer) => {
    store.set(key, webp);
  };

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("demo cover tests need DATABASE_URL");
    process.env.APP_ENV = "local";
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    demoOrgExisted = (await getDb().select().from(organizations).where(eq(organizations.name, DEMO_ORG_NAME))).length > 0;
    admin = await createUser({ admin: true });
    jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 30, b: 60 } } }).jpeg().toBuffer();
    const result = await createDemoCampaigns(
      getDb(), admin.id, { count: 2, payoutAddress: PAYOUT_ADDRESS, durationMode: "short" }, { appEnv: "local", getRate: rate }
    );
    ids = result.created.map((c) => c.id);
  });

  afterAll(async () => {
    const db = getDb();
    await db.delete(campaignMedia).where(inArray(campaignMedia.campaignId, ids));
    await db.delete(auditLog).where(inArray(auditLog.entityId, ids));
    await db.delete(campaigns).where(inArray(campaigns.id, ids));
    const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, DEMO_ORG_NAME));
    if (org) {
      await db.delete(orgMembers).where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, admin.id)));
      const left = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.orgId, org.id));
      if (!demoOrgExisted && left.length === 0) {
        await db.delete(auditLog).where(eq(auditLog.entityId, org.id));
        await db.delete(organizations).where(eq(organizations.id, org.id));
      }
    }
    await cleanUp();
  });

  it("refuses without FAL_KEY, outside local/dev and for campaigns that are not demo", async () => {
    const { impl, calls } = fakeFal(jpeg);
    await expect(startDemoCover(getDb(), ids[0]!, { apiKey: "", fetchImpl: impl })).rejects.toEqual(new DemoCoverError("not_configured"));
    await expect(startDemoCover(getDb(), ids[0]!, { apiKey: KEY, appEnv: "prod", fetchImpl: impl })).rejects.toEqual(new DemoCoverError("not_allowed"));
    await expect(
      startDemoCover(getDb(), "01890000-0000-7000-8000-000000000000", { apiKey: KEY, fetchImpl: impl })
    ).rejects.toEqual(new DemoCoverError("not_found"));
    await expect(finishDemoCover(getDb(), admin.id, ids[0]!, "../../etc", { apiKey: KEY, fetchImpl: impl })).rejects.toEqual(
      new DemoCoverError("bad_request")
    );
    expect(calls).toHaveLength(0);
  });

  it("submits to fal's queue with the key, polls, then stores a WebP cover and audits it", async () => {
    const { impl, calls } = fakeFal(jpeg, { statuses: ["IN_QUEUE", "IN_PROGRESS", "COMPLETED"] });
    const options = { apiKey: KEY, fetchImpl: impl, put };
    const started = await startDemoCover(getDb(), ids[0]!, options);
    expect(started).toEqual({ status: "pending", requestId: REQUEST_ID });
    expect(calls[0]).toMatchObject({ url: FAL_QUEUE, method: "POST", auth: `Key ${KEY}` });
    const body = calls[0]!.body as { prompt: string; num_images: number; aspect_ratio: string };
    expect(body.num_images).toBe(1);
    expect(body.aspect_ratio).toBe("4:3");
    const [row] = await getDb().select({ title: campaigns.title }).from(campaigns).where(eq(campaigns.id, ids[0]!));
    expect(body.prompt).toContain(sceneForTitle(row!.title));

    expect(await finishDemoCover(getDb(), admin.id, ids[0]!, REQUEST_ID, options)).toEqual({ status: "pending", requestId: REQUEST_ID });
    expect(await finishDemoCover(getDb(), admin.id, ids[0]!, REQUEST_ID, options)).toEqual({ status: "pending", requestId: REQUEST_ID });
    const done = await finishDemoCover(getDb(), admin.id, ids[0]!, REQUEST_ID, options);
    expect(done.status).toBe("done");

    // The CDN download carries no credentials.
    const download = calls.find((c) => c.url.startsWith("https://v3.fal.media/"));
    expect(download?.auth).toBeNull();

    const media = await getDb().select().from(campaignMedia).where(and(eq(campaignMedia.campaignId, ids[0]!), eq(campaignMedia.kind, "COVER")));
    expect(media).toHaveLength(1);
    expect(media[0]!.cid).toMatch(new RegExp(`^campaigns/${ids[0]}/[0-9a-f]{24}\\.webp$`));
    const stored = store.get(media[0]!.cid)!;
    expect(stored.subarray(8, 12).toString("ascii")).toBe("WEBP");
    const [audit] = await getDb().select().from(auditLog).where(and(eq(auditLog.entityId, ids[0]!), eq(auditLog.action, "demo.cover_generated")));
    expect(audit).toBeDefined();

    // A campaign with a cover is not sent to fal again (no second paid image).
    const again = fakeFal(jpeg);
    expect((await startDemoCover(getDb(), ids[0]!, { apiKey: KEY, fetchImpl: again.impl, put })).status).toBe("done");
    expect(again.calls).toHaveLength(0);
  });

  it("reports a failed submission and stores nothing", async () => {
    const { impl } = fakeFal(jpeg, { submitStatus: 401 });
    await expect(startDemoCover(getDb(), ids[1]!, { apiKey: KEY, fetchImpl: impl, put })).rejects.toEqual(new DemoCoverError("generation_failed"));
    const failedStatus = fakeFal(jpeg, { statuses: ["FAILED"] });
    await expect(finishDemoCover(getDb(), admin.id, ids[1]!, REQUEST_ID, { apiKey: KEY, fetchImpl: failedStatus.impl, put })).rejects.toEqual(
      new DemoCoverError("generation_failed")
    );
    expect(await getDb().select().from(campaignMedia).where(eq(campaignMedia.campaignId, ids[1]!))).toHaveLength(0);
  });
});

describe("browser cover loop", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it("starts, polls until done and stops early when FAL_KEY is missing", async () => {
    const seen: string[] = [];
    const answers = [json(202, { status: "pending", requestId: REQUEST_ID }), json(202, { status: "pending" }), json(201, { status: "done" })];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      seen.push(String(url));
      return answers.shift()!;
    }) as typeof fetch;
    expect(await generateCover("c1", { fetchImpl, sleep: async () => {}, maxPolls: 5 })).toBe("done");
    expect(seen).toEqual([
      "/api/admin/demo-campaigns/c1/cover",
      "/api/admin/demo-campaigns/c1/cover/check",
      "/api/admin/demo-campaigns/c1/cover/check",
    ]);

    const missingKey = (async () => json(503, { error: "not_configured" })) as typeof fetch;
    const progress: number[] = [];
    const result = await generateCovers(["a", "b"], (d) => progress.push(d), { fetchImpl: missingKey, sleep: async () => {} });
    expect(result).toEqual({ done: 0, failed: 0, notConfigured: true });
    expect(progress).toEqual([]);
  });

  it("gives up after the poll limit", async () => {
    const fetchImpl = (async (url: RequestInfo | URL) =>
      String(url).endsWith("/check") ? json(202, { status: "pending" }) : json(202, { status: "pending", requestId: REQUEST_ID })) as typeof fetch;
    expect(await generateCover("c2", { fetchImpl, sleep: async () => {}, maxPolls: 3 })).toBe("timeout");
  });
});

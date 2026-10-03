import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import * as schema from "@cherrio/db";
import messages from "../../messages/en.json";
import { getDb } from "@/lib/db";
import { POST as imageRoute } from "@/app/api/campaigns/[id]/media/images/route";
import { POST as documentRoute } from "@/app/api/campaigns/[id]/media/documents/route";
import { POST as videoRoute } from "@/app/api/campaigns/[id]/media/videos/route";
import { DELETE as removeRoute } from "@/app/api/campaigns/[id]/media/[mediaId]/route";
import { DELETE as takedownRoute } from "@/app/api/admin/campaigns/[id]/media/[mediaId]/route";
import { mediaRateLimiter } from "@/lib/security/rate-limit";
import { CAMPAIGN_ERROR_CODES } from "@/lib/campaigns/errors";
import { getPublicMediaConfig } from "@/lib/media/public-store";
import { cleanUp, createOrganization, createUser, ORIGIN, type TestUser } from "./helpers/organizations";

// Campaign media (ADR-039) against Postgres and the local S3: gallery images,
// video links and public PDFs, in any campaign status, with limits, removal
// and admin takedown.

const { campaigns, campaignMedia, auditLog } = schema;
type Result = { status: number; json: Record<string, unknown> | null };

async function read(res: Response): Promise<Result> {
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}
async function upload(route: typeof imageRoute, user: TestUser, id: string, bytes: Buffer, name: string, type: string) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], name, { type }));
  const encoded = new Response(form);
  const body = Buffer.from(await encoded.arrayBuffer());
  const res = await route(
    new Request(`${ORIGIN}/api/campaigns/${id}/media`, {
      method: "POST",
      headers: { Origin: ORIGIN, cookie: user.cookie, "Content-Type": encoded.headers.get("content-type")!, "Content-Length": String(body.length) },
      body,
    }),
    { params: Promise.resolve({ id }) }
  );
  return read(res);
}
const image = (user: TestUser, id: string, bytes: Buffer) => upload(imageRoute, user, id, bytes, "photo.jpg", "image/jpeg");
const pdf = (user: TestUser, id: string, bytes: Buffer, name = "Project plan.pdf") =>
  upload(documentRoute as typeof imageRoute, user, id, bytes, name, "application/pdf");
async function video(user: TestUser, id: string, url: string) {
  return read(
    await videoRoute(
      new Request(`${ORIGIN}/api/campaigns/${id}/media/videos`, {
        method: "POST",
        headers: { Origin: ORIGIN, cookie: user.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      { params: Promise.resolve({ id }) }
    )
  );
}
async function remove(route: typeof removeRoute, user: TestUser, id: string, mediaId: string) {
  return read(
    await route(new Request(`${ORIGIN}/api/campaigns/${id}/media/${mediaId}`, { method: "DELETE", headers: { Origin: ORIGIN, cookie: user.cookie } }), {
      params: Promise.resolve({ id, mediaId }),
    })
  );
}

const jpeg = () => sharp({ create: { width: 800, height: 600, channels: 3, background: "#3366aa" } }).jpeg().toBuffer();
const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
const mediaOf = (id: string, kind: "GALLERY" | "VIDEO" | "DOCUMENT" | "COVER") =>
  getDb().select().from(campaignMedia).where(and(eq(campaignMedia.campaignId, id), eq(campaignMedia.kind, kind)));

let n = 0;
async function campaignIn(owner: TestUser, orgId: string, status: "DRAFT" | "DEPLOYED") {
  const [row] = await getDb()
    .insert(campaigns)
    .values({
      orgId, starterUserId: owner.id, beneficiaryType: "ORGANIZATION", title: `Media test ${++n}`, slug: `media-${orgId}-${n}`,
      story: { format: "plain", text: "x".repeat(60) }, cause: "animals", country: "SI", targetEurCents: "100000", durationDays: 30, status,
      ...(status === "DEPLOYED"
        ? { beneficiaryAddress: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", onchainAddress: `0x${n.toString(16).padStart(40, "0")}` }
        : {}),
    })
    .returning({ id: campaigns.id });
  return row!.id;
}

describe("campaign media (Postgres + S3)", () => {
  let owner: TestUser;
  let orgId: string;
  let baseUrl: string;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("media tests need DATABASE_URL");
    process.env.APP_ENV = "local";
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    await getDb().execute(sql`select 1`);
    baseUrl = getPublicMediaConfig().baseUrl;
    const bucket = await fetch(baseUrl, { method: "PUT" }).catch((cause) => {
      throw new Error("media tests need the local S3 on 127.0.0.1:9090", { cause });
    });
    if (!bucket.ok && bucket.status !== 409) throw new Error(`cannot create the public test bucket: HTTP ${bucket.status}`);
    owner = await createUser();
    orgId = (await createOrganization(owner)).id;
  }, 60_000);
  beforeEach(() => mediaRateLimiter.reset());
  afterAll(async () => {
    const own = await getDb().select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.orgId, orgId));
    for (const { id } of own) await getDb().delete(campaignMedia).where(eq(campaignMedia.campaignId, id));
    await cleanUp();
  });

  it("a live (DEPLOYED) campaign gets an image, a video and a PDF — nothing on-chain changes, so all statuses allow it", async () => {
    const id = await campaignIn(owner, orgId, "DEPLOYED");
    const img = await image(owner, id, await jpeg());
    expect(img.status).toBe(201);
    expect(img.json!.url).toMatch(new RegExp(`/campaigns/${id}/g-[0-9a-f]{24}\\.webp$`));
    const stored = await fetch(img.json!.url as string);
    expect(stored.status).toBe(200);
    expect(stored.headers.get("content-type")).toBe("image/webp");

    const vid = await video(owner, id, "https://youtu.be/dQw4w9WgXcQ");
    expect(vid).toMatchObject({ status: 201, json: { video: { provider: "youtube", id: "dQw4w9WgXcQ" } } });
    expect((await mediaOf(id, "VIDEO"))[0]).toMatchObject({ cid: "youtube:dQw4w9WgXcQ", storage: "EXTERNAL", createdBy: owner.id });

    const doc = await pdf(owner, id, PDF_BYTES, "C:\\Users\\Jana\\Budget 2026.pdf");
    expect(doc).toMatchObject({ status: 201, json: { label: "Budget 2026.pdf" } });
    const file = await fetch(doc.json!.url as string);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await file.arrayBuffer()).equals(PDF_BYTES)).toBe(true); // stored unchanged
    expect((await mediaOf(id, "DOCUMENT"))[0]).toMatchObject({ label: "Budget 2026.pdf", sizeBytes: PDF_BYTES.length });

    const audit = await getDb().select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "campaign.media_add")));
    expect(audit.map((a) => (a.data as { kind: string }).kind).sort()).toEqual(["DOCUMENT", "GALLERY", "VIDEO"]);
    expect((await getDb().select().from(campaigns).where(eq(campaigns.id, id)))[0]!.status).toBe("DEPLOYED");
  });

  it("limits: 10 images, 3 videos, 5 PDFs — the next one is refused and nothing is stored", async () => {
    const id = await campaignIn(owner, orgId, "DRAFT");
    const photo = await jpeg();
    for (let i = 0; i < 10; i++) expect((await image(owner, id, photo)).status).toBe(201);
    mediaRateLimiter.reset();
    expect(await image(owner, id, photo)).toEqual({ status: 409, json: { error: "too_many_images" } });
    expect(await mediaOf(id, "GALLERY")).toHaveLength(10);

    for (const v of ["https://youtu.be/aaaaaaaaaaa", "https://youtu.be/bbbbbbbbbbb", "https://vimeo.com/123"]) {
      expect((await video(owner, id, v)).status).toBe(201);
    }
    expect(await video(owner, id, "https://vimeo.com/456")).toEqual({ status: 409, json: { error: "too_many_videos" } });

    for (let i = 0; i < 5; i++) expect((await pdf(owner, id, PDF_BYTES)).status).toBe(201);
    expect(await pdf(owner, id, PDF_BYTES)).toEqual({ status: 409, json: { error: "too_many_documents" } });
    expect(await mediaOf(id, "DOCUMENT")).toHaveLength(5);
  });

  it("refuses: HTML as .pdf, a PDF over 20 MB, a non-video link, and anyone but the organisation's admin", async () => {
    const id = await campaignIn(owner, orgId, "DRAFT");
    expect(await pdf(owner, id, Buffer.from("<html><script>alert(1)</script></html>"), "evil.pdf")).toEqual({
      status: 400,
      json: { error: "file_type_not_allowed" },
    });
    const big = Buffer.concat([PDF_BYTES, Buffer.alloc(20 * 1024 * 1024)]);
    expect(await pdf(owner, id, big)).toEqual({ status: 413, json: { error: "file_too_large" } });
    expect(await video(owner, id, "https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ")).toEqual({
      status: 400,
      json: { error: "video_url_invalid" },
    });
    const stranger = await createUser();
    expect(await image(stranger, id, await jpeg())).toEqual({ status: 404, json: { error: "not_found" } });
    expect(await video(stranger, id, "https://youtu.be/dQw4w9WgXcQ")).toEqual({ status: 404, json: { error: "not_found" } });
    expect(await mediaOf(id, "GALLERY")).toHaveLength(0);
    expect(await mediaOf(id, "DOCUMENT")).toHaveLength(0);
  });

  it("remove: the organisation deletes an item and its object; the cover cannot be removed here", async () => {
    const id = await campaignIn(owner, orgId, "DEPLOYED");
    const img = await image(owner, id, await jpeg());
    expect(await remove(removeRoute, owner, id, img.json!.id as string)).toEqual({ status: 204, json: null });
    expect(await mediaOf(id, "GALLERY")).toHaveLength(0);
    expect((await fetch(img.json!.url as string)).status).toBe(404);

    const [cover] = await getDb()
      .insert(campaignMedia)
      .values({ campaignId: id, kind: "COVER", cid: `campaigns/${id}/cover.webp`, storage: "HETZNER_PUBLIC" })
      .returning({ id: campaignMedia.id });
    expect(await remove(removeRoute, owner, id, cover!.id)).toEqual({ status: 404, json: { error: "media_not_found" } });
    expect(await mediaOf(id, "COVER")).toHaveLength(1);

    const stranger = await createUser();
    const vid = await video(owner, id, "https://vimeo.com/76979871");
    expect(await remove(removeRoute, stranger, id, vid.json!.id as string)).toEqual({ status: 404, json: { error: "not_found" } });
  });

  it("takedown by a platform admin is audited; anyone else gets 404", async () => {
    const id = await campaignIn(owner, orgId, "DEPLOYED");
    const doc = await pdf(owner, id, PDF_BYTES);
    const mediaId = doc.json!.id as string;
    expect(await remove(takedownRoute, owner, id, mediaId)).toEqual({ status: 404, json: null });
    const admin = await createUser({ admin: true });
    expect(await remove(takedownRoute, admin, id, mediaId)).toEqual({ status: 204, json: null });
    expect(await mediaOf(id, "DOCUMENT")).toHaveLength(0);
    expect((await fetch(doc.json!.url as string)).status).toBe(404);
    const audit = await getDb().select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "campaign.media_takedown")));
    expect(audit).toMatchObject([{ actorUserId: admin.id, data: { mediaId, kind: "DOCUMENT" } }]);
    expect(await remove(takedownRoute, admin, id, mediaId)).toEqual({ status: 404, json: null });
  });

  it("every error code has a message", () => {
    const texts = messages.campaigns.errors as Record<string, string>;
    for (const code of CAMPAIGN_ERROR_CODES) expect(texts[code], code).toBeTruthy();
  });
});

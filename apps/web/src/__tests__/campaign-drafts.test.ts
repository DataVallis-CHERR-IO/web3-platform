import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import * as schema from "@cherrio/db";
import messages from "../../messages/en.json";
import { getDb } from "@/lib/db";
import { POST as createRoute } from "@/app/api/campaigns/route";
import { PATCH as updateRoute } from "@/app/api/campaigns/[id]/route";
import { POST as submitRoute } from "@/app/api/campaigns/[id]/submit/route";
import { POST as coverRoute } from "@/app/api/campaigns/[id]/cover/route";
import { applicationRateLimiter } from "@/lib/security/rate-limit";
import { CAMPAIGN_ERROR_CODES } from "@/lib/campaigns/errors";
import { MAX_IMAGE_BYTES } from "@/lib/media/image";
import { getPublicMediaConfig, publicMediaUrl } from "@/lib/media/public-store";
import { cleanUp, createOrganization, createUser, ORIGIN, type TestUser } from "./helpers/organizations";

// Integration tests for campaign drafts and the cover image: real handlers,
// Postgres, and the public bucket in the local s3mock (read back over HTTP,
// the way a browser reads it).

const { campaigns, campaignMedia, auditLog, orgMembers } = schema;
const draft = {
  title: "A new roof for the animal shelter",
  story: "The roof of our shelter leaks.\n\nWith your help we replace it before winter and keep forty dogs dry.",
  cause: "animals",
  country: "SI",
  goalCurrency: "EUR",
  goal: 12_000,
  durationDays: 30,
};
const MARKER = "cherrio-test-exif-marker";

type Result = { status: number; json: Record<string, unknown> };
async function call(route: (req: Request, ctx: never) => Promise<Response>, user: TestUser | null, id: string | null, method: string, body?: unknown): Promise<Result> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: ORIGIN };
  if (user) headers.cookie = user.cookie;
  const request = new Request(`${ORIGIN}/api/campaigns`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await route(request, { params: Promise.resolve({ id }) } as never);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
const create = (user: TestUser | null, organizationId: string, override: Record<string, unknown> = {}) =>
  call(createRoute as never, user, null, "POST", { ...draft, organizationId, ...override });
const update = (user: TestUser, id: string, override: Record<string, unknown> = {}) =>
  call(updateRoute as never, user, id, "PATCH", { ...draft, ...override });
const submit = (user: TestUser, id: string) => call(submitRoute as never, user, id, "POST");

async function uploadCover(user: TestUser, id: string, bytes: Buffer, contentLength?: string | null): Promise<Result> {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], "IMG_2041 Jane at home.jpg", { type: "image/jpeg" }));
  const encoded = new Response(form);
  const body = Buffer.from(await encoded.arrayBuffer());
  const headers: Record<string, string> = {
    Origin: ORIGIN,
    cookie: user.cookie,
    "Content-Type": encoded.headers.get("content-type")!,
  };
  const length = contentLength === undefined ? String(body.length) : contentLength;
  if (length !== null) headers["Content-Length"] = length;
  const res = await coverRoute(new Request(`${ORIGIN}/api/campaigns/${id}/cover`, { method: "POST", headers, body }), {
    params: Promise.resolve({ id }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** A 2400×1200 JPEG with EXIF: a copyright marker, orientation and a GPS position. */
const photoWithExif = () =>
  sharp({ create: { width: 2400, height: 1200, channels: 3, background: { r: 180, g: 60, b: 70 } } })
    .jpeg()
    .withExif({
      IFD0: { Copyright: MARKER },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "46/1 3/1 20/1", GPSLongitudeRef: "E", GPSLongitude: "14/1 30/1 20/1" },
    })
    .toBuffer();

const campaignRow = async (id: string) => (await getDb().select().from(campaigns).where(eq(campaigns.id, id)))[0]!;
const coverRows = (id: string) =>
  getDb().select().from(campaignMedia).where(and(eq(campaignMedia.campaignId, id), eq(campaignMedia.kind, "COVER")));
const campaignCount = async (orgId: string) =>
  (await getDb().select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.orgId, orgId))).length;

describe("campaign drafts and cover image (Postgres + s3mock)", () => {
  let owner: TestUser;
  let orgId: string;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("campaign tests need DATABASE_URL");
    process.env.APP_ENV = "local";
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    await getDb().execute(sql`select 1`);
    // The public bucket of the local s3mock. Fails if s3mock is not running — never skips.
    const { baseUrl } = getPublicMediaConfig();
    const bucket = await fetch(baseUrl, { method: "PUT" }).catch((cause) => {
      throw new Error("campaign tests need s3mock on 127.0.0.1:9090 (docker compose up -d)", { cause });
    });
    if (!bucket.ok && bucket.status !== 409) throw new Error(`cannot create the public test bucket: HTTP ${bucket.status}`);

    owner = await createUser();
    orgId = (await createOrganization(owner)).id;
  }, 60_000);
  beforeEach(() => applicationRateLimiter.reset());
  afterAll(cleanUp);

  it("create: a DRAFT with integer cents, the story as plain text, a slug, and the creator recorded", async () => {
    const { status, json } = await create(owner, orgId, { title: "  Streha za zavetišče — Črnuče  " });
    expect(status).toBe(201);
    expect(json.slug).toBe("streha-za-zavetisce-crnuce");
    expect(await campaignRow(json.id as string)).toMatchObject({
      status: "DRAFT",
      orgId,
      starterUserId: owner.id,
      beneficiaryType: "ORGANIZATION",
      title: "Streha za zavetišče — Črnuče",
      story: { format: "plain", text: draft.story },
      goalAmountMinor: "1200000",
      durationDays: 30,
      beneficiaryAddress: null, // copied from the organisation at approval, never typed here
      offchainId: null,
      submittedAt: null,
    });
  });

  it("a USD goal (ADR-060) is stored in USD cents with no EUR target; switching back to EUR fills it again", async () => {
    const created = await create(owner, orgId, { title: "School books for Ohio", goalCurrency: "USD", goal: 25_000 });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    expect(await campaignRow(id)).toMatchObject({ goalCurrency: "USD", goalAmountMinor: "2500000", targetEurCents: null });
    expect((await update(owner, id, { goalCurrency: "EUR", goal: 20_000 })).status).toBe(200);
    expect(await campaignRow(id)).toMatchObject({ goalCurrency: "EUR", goalAmountMinor: "2000000", targetEurCents: "2000000" });
  });

  it("create is refused for anyone but an ORG_ADMIN of an APPROVED organisation, and for invalid input", async () => {
    const stranger = await createUser();
    const member = await createUser();
    await getDb().insert(orgMembers).values({ orgId, userId: member.id, role: "ORG_MEMBER" });
    const pendingOwner = await createUser();
    const pendingOrg = await createOrganization(pendingOwner, "PENDING");
    const before = await campaignCount(orgId);

    expect(await create(null, orgId)).toEqual({ status: 401, json: { error: "unauthorized" } });
    expect(await create(stranger, orgId)).toEqual({ status: 404, json: { error: "not_found" } });
    expect(await create(member, orgId)).toEqual({ status: 404, json: { error: "not_found" } });
    expect(await create(pendingOwner, pendingOrg.id)).toEqual({ status: 409, json: { error: "organization_not_approved" } });
    const invalid = await create(owner, orgId, { title: "Roof", goal: 50, durationDays: 120, story: "<b>short</b>" });
    expect(invalid.status).toBe(400);
    expect((invalid.json.fields as string[]).sort()).toEqual(["durationDays", "goal", "story", "title"]);
    // ADR-060: only EUR and USD goals; a crypto ticker or another fiat currency is refused.
    for (const goalCurrency of ["GBP", "USDC", ""]) {
      expect((await create(owner, orgId, { goalCurrency })).json).toMatchObject({ error: "validation_failed", fields: ["goalCurrency"] });
    }

    expect(await campaignCount(orgId)).toBe(before);
    expect(await campaignCount(pendingOrg.id)).toBe(0);
  });

  it("edit: any ORG_ADMIN of the organisation; the slug follows the title until the first submit and is unique", async () => {
    const colleague = await createUser();
    await getDb().insert(orgMembers).values({ orgId, userId: colleague.id, role: "ORG_ADMIN" });
    const first = await create(owner, orgId, { title: "Winter food for the shelter" });
    const second = await create(colleague, orgId, { title: "Winter food for the shelter" });
    expect([first.json.slug, second.json.slug]).toEqual(["winter-food-for-the-shelter", "winter-food-for-the-shelter-2"]);

    const edited = await update(colleague, first.json.id as string, { title: "Winter food and blankets", goal: 800 });
    expect(edited).toEqual({ status: 200, json: { id: first.json.id, slug: "winter-food-and-blankets" } });
    expect(await campaignRow(first.json.id as string)).toMatchObject({ goalCurrency: "EUR", goalAmountMinor: "80000", slug: "winter-food-and-blankets" });
    // The first campaign gave up its slug; the second, never submitted, now takes it —
    // and saving again with the same title does not make it collide with itself.
    for (let i = 0; i < 2; i++) {
      expect((await update(owner, second.json.id as string, { title: "Winter food for the shelter" })).json.slug).toBe(
        "winter-food-for-the-shelter"
      );
    }

    const stranger = await createUser();
    expect(await update(stranger, first.json.id as string)).toEqual({ status: 404, json: { error: "not_found" } });
    expect((await campaignRow(first.json.id as string)).title).toBe("Winter food and blankets");
  });

  it("cover: re-encoded to WebP without EXIF/GPS, at most 1600 px wide, under a random key; replacing deletes the old object", async () => {
    const { json } = await create(owner, orgId, { title: "Cover image test campaign" });
    const id = json.id as string;
    const photo = await photoWithExif();
    expect(photo.includes(Buffer.from(MARKER))).toBe(true); // the upload really carries EXIF
    expect((await sharp(photo).metadata()).exif).toBeDefined();

    const first = await uploadCover(owner, id, photo);
    expect(first.status).toBe(201);
    const [row] = await coverRows(id);
    expect(row).toMatchObject({ storage: "HETZNER_PUBLIC", kind: "COVER" });
    expect(row!.cid).toMatch(new RegExp(`^campaigns/${id}/[0-9a-f]{24}\\.webp$`)); // no file name in the key
    expect(first.json.url).toBe(publicMediaUrl(row!.cid));

    const stored = Buffer.from(await (await fetch(first.json.url as string)).arrayBuffer()); // public read, no credentials
    const meta = await sharp(stored).metadata();
    expect(meta).toMatchObject({ format: "webp", width: 1600, height: 800 });
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(stored.includes(Buffer.from(MARKER))).toBe(false);
    expect(stored.includes(Buffer.from("Exif"))).toBe(false);

    const png = await sharp({ create: { width: 800, height: 600, channels: 4, background: "#336699" } }).png().toBuffer();
    const second = await uploadCover(owner, id, png);
    expect(second.status).toBe(201);
    expect(await coverRows(id)).toHaveLength(1);
    expect((await sharp(Buffer.from(await (await fetch(second.json.url as string)).arrayBuffer())).metadata()).width).toBe(800); // not enlarged
    expect((await fetch(first.json.url as string)).status).toBe(404); // the replaced object is gone
  });

  it("cover is refused: not an image, too large, no Content-Length, somebody else's campaign", async () => {
    const { json } = await create(owner, orgId, { title: "Refused cover test campaign" });
    const id = json.id as string;
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    expect(await uploadCover(owner, id, html)).toEqual({ status: 400, json: { error: "file_type_not_allowed" } });
    const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(2000)]); // right signature, not an image
    expect(await uploadCover(owner, id, fakeJpeg)).toEqual({ status: 400, json: { error: "file_type_not_allowed" } });
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(MAX_IMAGE_BYTES)]);
    expect(await uploadCover(owner, id, big)).toEqual({ status: 413, json: { error: "file_too_large" } });
    expect(await uploadCover(owner, id, big, "1000")).toEqual({ status: 413, json: { error: "file_too_large" } }); // lying header
    expect(await uploadCover(owner, id, html, null)).toEqual({ status: 411, json: { error: "length_required" } });
    const stranger = await createUser();
    expect(await uploadCover(stranger, id, await photoWithExif())).toEqual({ status: 404, json: { error: "not_found" } });
    expect(await coverRows(id)).toHaveLength(0);
  });

  it("submit: needs a cover; then PENDING_REVIEW, audited, no more edits; after a rejection it can be edited and submitted again with the same slug", async () => {
    const { json } = await create(owner, orgId, { title: "Submit test campaign" });
    const id = json.id as string;
    expect(await submit(owner, id)).toEqual({ status: 409, json: { error: "cover_required" } });
    expect((await campaignRow(id)).status).toBe("DRAFT");

    expect((await uploadCover(owner, id, await photoWithExif())).status).toBe(201);
    expect(await submit(owner, id)).toEqual({ status: 200, json: { id, status: "PENDING_REVIEW" } });
    const submitted = await campaignRow(id);
    expect(submitted.status).toBe("PENDING_REVIEW");
    expect(submitted.submittedAt).toBeInstanceOf(Date);
    const audit = await getDb().select().from(auditLog).where(eq(auditLog.entityId, id));
    expect(audit).toMatchObject([{ action: "campaign.submit", actorUserId: owner.id, data: { organizationId: orgId } }]);

    expect(await update(owner, id, { title: "Changed while in review" })).toEqual({ status: 409, json: { error: "not_editable" } });
    expect(await uploadCover(owner, id, await photoWithExif())).toEqual({ status: 409, json: { error: "not_editable" } });
    expect(await submit(owner, id)).toEqual({ status: 409, json: { error: "not_editable" } });
    expect((await campaignRow(id)).title).toBe("Submit test campaign");

    // The review itself is TASK-010b; here the rejection is written directly.
    await getDb().update(campaigns).set({ status: "REJECTED", reviewNote: "Please add what the money is for." }).where(eq(campaigns.id, id));
    const edited = await update(owner, id, { title: "Submit test campaign, with details" });
    expect(edited.json.slug).toBe("submit-test-campaign"); // fixed since the first submit
    expect(await submit(owner, id)).toEqual({ status: 200, json: { id, status: "PENDING_REVIEW" } });
  });

  it("an organisation has at most 5 campaigns in review, approved or live; the 6th submit is refused", async () => {
    const busyOwner = await createUser();
    const busyOrg = await createOrganization(busyOwner);
    const { json } = await create(busyOwner, busyOrg.id, { title: "The sixth campaign" });
    const id = json.id as string;
    expect((await uploadCover(busyOwner, id, await photoWithExif())).status).toBe(201);
    const filler = (n: number, status: "PENDING_REVIEW" | "DEPLOYED" | "REJECTED") => ({
      orgId: busyOrg.id, starterUserId: busyOwner.id, beneficiaryType: "ORGANIZATION" as const,
      beneficiaryAddress: busyOrg.payoutAddress, title: `Filler ${n}`, slug: `filler-${busyOrg.id}-${n}`,
      story: { format: "plain", text: draft.story }, cause: "animals", country: "SI",
      goalAmountMinor: "100000", durationDays: 30, status,
    });
    await getDb().insert(campaigns).values([
      filler(1, "PENDING_REVIEW"), filler(2, "PENDING_REVIEW"), filler(3, "DEPLOYED"), filler(4, "DEPLOYED"),
      filler(5, "REJECTED"), // does not count
    ]);
    expect(await submit(busyOwner, id)).toEqual({ status: 200, json: { id, status: "PENDING_REVIEW" } }); // the 5th active one

    const seventh = await create(busyOwner, busyOrg.id, { title: "One too many" });
    expect((await uploadCover(busyOwner, seventh.json.id as string, await photoWithExif())).status).toBe(201);
    expect(await submit(busyOwner, seventh.json.id as string)).toEqual({ status: 409, json: { error: "too_many_active" } });
    expect((await campaignRow(seventh.json.id as string)).status).toBe("DRAFT");
  });

  it("every error code of the campaign routes has a next-intl message", () => {
    expect(Object.keys(messages.campaigns.errors).sort()).toEqual([...CAMPAIGN_ERROR_CODES].sort());
  });
});

import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
import sharp from "sharp";
import * as schema from "@cherrio/db";
import { tokenColor } from "@cherrio/ui/lib/tokens";
import { getDb } from "@/lib/db";
import { putPublicImage, publicMediaUrl, removePublicObject } from "@/lib/media/public-store";
import { clampTitle, coverDataUri, loadOgFonts, OG_SIZE } from "@/lib/og/share-image";
import CampaignImage from "@/app/[locale]/campaigns/[slug]/opengraph-image";
import SiteImage from "@/app/[locale]/opengraph-image";
import { createUser, cleanUp, type TestUser } from "./helpers/organizations";

// TASK-055b: link preview images. Real Postgres and the local public bucket.
// Vitest has no React Server Components: next-intl's server translator is
// replaced by the same messages through next-intl's core translator.
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const messages = (await import("../../messages/en.json")).default;
  return {
    getTranslations: async ({ locale, namespace }: { locale: string; namespace: string }) =>
      createTranslator({ locale, messages, namespace: namespace as never }),
  };
});

const RUN = Date.now().toString(36);
const PNG = [0x89, 0x50, 0x4e, 0x47];
const campaignIds: string[] = [];
const keys: string[] = [];
const orgIds: string[] = [];
let starter: TestUser;

async function pngSize(response: Response) {
  expect(response.headers.get("content-type")).toBe("image/png");
  const bytes = Buffer.from(await response.arrayBuffer());
  expect([...bytes.subarray(0, 4)]).toEqual(PNG);
  const meta = await sharp(bytes).metadata();
  return { width: meta.width, height: meta.height, bytes };
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("og image tests need DATABASE_URL");
  process.env.APP_ENV = "local";
  starter = await createUser();
});

afterAll(async () => {
  await getDb().delete(schema.campaignMedia).where(inArray(schema.campaignMedia.campaignId, campaignIds));
  await getDb().delete(schema.campaigns).where(inArray(schema.campaigns.id, campaignIds));
  await getDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  for (const key of keys) await removePublicObject(key);
  await cleanUp();
});

describe("design tokens for images", () => {
  it("resolve references in both themes", () => {
    expect(tokenColor("accent")).toBe("#ff0052");
    expect(tokenColor("ink")).toBe("#090c0d");
    expect(tokenColor("ink", "dark")).toBe("#e3e3e3");
    expect(tokenColor("surface-raised")).toBe("#ffffff");
    expect(() => tokenColor("no-such-token")).toThrow(/unknown colour token/);
  });
});

describe("share image helpers", () => {
  it("cut long titles at a word, keep short ones", () => {
    expect(clampTitle("Roof for the shelter")).toBe("Roof for the shelter");
    const long = "A new roof for the animal shelter in Maribor before the winter comes and the snow falls on the old one";
    const cut = clampTitle(long);
    expect(cut.length).toBeLessThanOrEqual(81);
    expect(cut.endsWith("…")).toBe(true);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
  });

  it("load the brand fonts, Latin and Latin Extended (č, š, ž)", async () => {
    const fonts = await loadOgFonts();
    expect(fonts.map((f) => `${f.name}/${f.weight}`)).toEqual([
      "Archivo Black/400", "Archivo Black Ext/400", "Archivo/400", "Archivo Ext/400", "Archivo/700", "Archivo Ext/700",
    ]);
    for (const f of fonts) expect(f.data.byteLength).toBeGreaterThan(5000);
  });

  it("turn a WebP cover into a JPEG of the left column; missing covers give null", async () => {
    const key = `campaigns/og-${RUN}/cover.webp`;
    keys.push(key);
    const webp = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#336699" } }).webp().toBuffer();
    await putPublicImage(key, webp);
    const uri = await coverDataUri(publicMediaUrl(key));
    expect(uri).toMatch(/^data:image\/jpeg;base64,/);
    const meta = await sharp(Buffer.from(uri!.split(",")[1]!, "base64")).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 520, 630]);
    expect(await coverDataUri(null)).toBeNull();
    expect(await coverDataUri(publicMediaUrl(`campaigns/og-${RUN}/missing.webp`))).toBeNull();
  });
});

describe("preview image routes", () => {
  it("render a published campaign (with a Slovenian title) and fall back for an unknown one", async () => {
    const slug = `og-${RUN}`;
    // Public campaign pages list organisation campaigns (TASK-011a).
    const [org] = await getDb()
      .insert(schema.organizations)
      .values({ source: "REGISTERED", name: `Društvo ${RUN}`, country: "SI", registry: "NONE", causes: ["education"], kybStatus: "APPROVED" })
      .returning({ id: schema.organizations.id });
    orgIds.push(org!.id);
    const [row] = await getDb()
      .insert(schema.campaigns)
      .values({
        orgId: org!.id, starterUserId: starter.id, beneficiaryType: "ORGANIZATION", title: `Šola za vse — nova streha ${RUN}`, slug,
        story: { format: "plain", text: "Story. ".repeat(20) }, cause: "education", country: "SI", targetEurCents: "1000000",
        durationDays: 30, status: "DEPLOYED", eurUsdRate: "1.17000000", rateSource: "ECB", rateAt: new Date(),
        targetUsdc: 11_700_000_000n, beneficiaryAddress: `0x${randomBytes(20).toString("hex")}`,
        deadline: new Date(Date.now() + 10 * 86_400_000), onchainAddress: `0x${randomBytes(20).toString("hex")}`,
      })
      .returning({ id: schema.campaigns.id });
    campaignIds.push(row!.id);

    const campaign = await CampaignImage({ params: Promise.resolve({ locale: "en", slug }) });
    const shown = await pngSize(campaign);
    expect([shown.width, shown.height]).toEqual([OG_SIZE.width, OG_SIZE.height]);
    expect(campaign.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=300"); // progress changes: never "immutable"

    const unknown = await CampaignImage({ params: Promise.resolve({ locale: "en", slug: `no-such-${RUN}` }) });
    expect([(await pngSize(unknown)).width]).toEqual([OG_SIZE.width]);

    const site = await SiteImage({ params: Promise.resolve({ locale: "en" }) });
    const s = await pngSize(site);
    expect([s.width, s.height]).toEqual([OG_SIZE.width, OG_SIZE.height]);
    // The campaign image and the site image are different pictures.
    expect(shown.bytes.equals(s.bytes)).toBe(false);
  }, 30_000);
});

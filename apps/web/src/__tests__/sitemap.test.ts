import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { TRUST_SCORE_VERSION } from "@cherrio/shared/trust";
import { getDb } from "@/lib/db";
import { indexXml, organizationUrls, pageUrls, sitemapFiles, urlsetXml, ORGS_PER_FILE } from "@/lib/seo/sitemap";
import { llmsTxt } from "@/lib/seo/llms";
import { robotsBody } from "@/lib/security/robots";

// TASK-018a: sitemap index, sitemap files, llms.txt and the prod robots Sitemap line.

if (!process.env.DATABASE_URL) throw new Error("sitemap tests need DATABASE_URL");
const db = getDb();
const { organizations, trustScores } = schema;
const RUN = `Smap${Date.now().toString(36)}`;
const ids: string[] = [];

beforeAll(async () => {
  for (const listed of [true, true, false]) {
    const [o] = await db
      .insert(organizations)
      .values({ source: "IMPORTED", name: `${RUN} ${ids.length}`, country: "GB", registry: "NONE", causes: [], kybStatus: "NONE" })
      .returning({ id: organizations.id });
    ids.push(o!.id);
    await db.insert(trustScores).values({
      orgId: o!.id, version: TRUST_SCORE_VERSION, score: "30.00", components: {}, listed, registered: false, country: "GB", causes: [], raised: "0",
    });
  }
});

afterAll(async () => {
  await db.delete(trustScores).where(inArray(trustScores.orgId, ids));
  await db.delete(organizations).where(inArray(organizations.id, ids));
});

describe("sitemaps", () => {
  it("lists listed organisation profiles only, with the score date as lastmod", async () => {
    const urls = (await organizationUrls(db, "https://x.example", 0)).map((u) => u.loc);
    expect(urls).toContain(`https://x.example/en/charity-market-cap/${ids[0]}`);
    expect(urls).toContain(`https://x.example/en/charity-market-cap/${ids[1]}`);
    expect(urls).not.toContain(`https://x.example/en/charity-market-cap/${ids[2]}`); // not listed
    expect(await organizationUrls(db, "https://x.example", 1000)).toEqual([]); // past the last file
  });

  it("splits organisations into files of at most 40,000 and always has pages + campaigns", async () => {
    const files = await sitemapFiles(db);
    expect(files.slice(0, 3)).toEqual(["pages.xml", "campaigns.xml", "organizations-0.xml"]);
    expect(ORGS_PER_FILE).toBeLessThanOrEqual(50_000);
    expect(pageUrls("https://x.example").map((u) => u.loc)).toContain("https://x.example/en/charity-market-cap/methodology");
  });

  it("writes valid XML with escaped URLs", () => {
    expect(urlsetXml([{ loc: "https://x.example/en/a&b", lastmod: "2026-10-08" }])).toContain(
      "<url><loc>https://x.example/en/a&amp;b</loc><lastmod>2026-10-08</lastmod></url>"
    );
    expect(indexXml(["https://x.example/sitemaps/pages.xml"])).toContain("<sitemap><loc>https://x.example/sitemaps/pages.xml</loc></sitemap>");
  });

  it("names the sitemap in robots.txt on prod only; llms.txt points to the main pages", () => {
    expect(robotsBody("prod", "https://app.cherr.io")).toContain("Sitemap: https://app.cherr.io/sitemap.xml");
    expect(robotsBody("dev", "https://dev.cherr.io")).not.toContain("Sitemap:");
    const llms = llmsTxt("https://app.cherr.io");
    expect(llms).toMatch(/^# CHERR\.IO\n\n> /);
    expect(llms).toContain("(https://app.cherr.io/en/charity-market-cap/methodology)");
    expect(llms).toContain("donor ratings 30 %");
  });
});

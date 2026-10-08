/**
 * GET /sitemap.xml — sitemap index (TASK-018a): the fixed pages, published
 * campaigns and every listed Charity Market Cap profile, split into files of
 * at most 40,000 URLs. Listed in robots.txt on prod.
 */
import { parseAppEnv } from "@cherrio/shared";
import { getDb } from "@/lib/db";
import { getExpectedOrigin } from "@/lib/security/origin";
import { indexXml, sitemapFiles } from "@/lib/seo/sitemap";

export const dynamic = "force-dynamic";

export async function GET() {
  const origin = getExpectedOrigin(parseAppEnv(process.env.APP_ENV ?? "local"));
  const files = await sitemapFiles(getDb());
  return new Response(indexXml(files.map((f) => `${origin}/sitemaps/${f}`)), {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}

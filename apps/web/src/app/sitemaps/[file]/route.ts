/** GET /sitemaps/<file>.xml — one file of the sitemap index (TASK-018a). */
import { parseAppEnv } from "@cherrio/shared";
import { getDb } from "@/lib/db";
import { getExpectedOrigin } from "@/lib/security/origin";
import { campaignUrls, organizationUrls, pageUrls, urlsetXml, type SitemapUrl } from "@/lib/seo/sitemap";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const origin = getExpectedOrigin(parseAppEnv(process.env.APP_ENV ?? "local"));
  const db = getDb();
  let urls: SitemapUrl[] | null = null;
  if (file === "pages.xml") urls = pageUrls(origin);
  else if (file === "campaigns.xml") urls = await campaignUrls(db, origin);
  else {
    const m = /^organizations-(\d{1,4})\.xml$/.exec(file);
    if (m) {
      urls = await organizationUrls(db, origin, Number(m[1]));
      if (urls.length === 0) urls = null; // past the last file
    }
  }
  if (!urls) return new Response("Not found", { status: 404 });
  return new Response(urlsetXml(urls), {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=86400" },
  });
}

import { sql } from "drizzle-orm";
import type { Database } from "@cherrio/db";
import { TRUST_SCORE_VERSION } from "@cherrio/shared/trust";

// Sitemaps (TASK-018a): one index and files of at most ORGS_PER_FILE URLs
// (the protocol allows 50,000 per file), so search engines find every public
// page — ~615k Charity Market Cap profiles on dev today. Only pages that are
// public: listed organisations, published campaigns, the fixed pages.

export const ORGS_PER_FILE = 40_000;
export const LOCALES = ["en"] as const;

/** Fixed public pages, without the locale prefix. */
export const STATIC_PAGES = [
  "", "/campaigns", "/charity-market-cap", "/charity-market-cap/methodology", "/emergency-pool", "/how-it-works",
  "/about", "/docs", "/docs/api", "/terms", "/privacy", "/licences",
] as const;

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
}

const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export function urlsetXml(urls: SitemapUrl[]): string {
  const body = urls
    .map((u) => `<url><loc>${escapeXml(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

export function indexXml(files: string[]): string {
  const body = files.map((f) => `<sitemap><loc>${escapeXml(f)}</loc></sitemap>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
}

async function listedCount(db: Database): Promise<number> {
  const [row] = (await db.execute(sql`
    select count(*)::int as n from app.trust_scores where version = ${TRUST_SCORE_VERSION} and listed
  `)) as unknown as { n: number }[];
  return Number(row?.n ?? 0);
}

/** File names of the index: pages, campaigns, organisations-0 … organisations-n. */
export async function sitemapFiles(db: Database): Promise<string[]> {
  const files = Math.max(1, Math.ceil((await listedCount(db)) / ORGS_PER_FILE));
  return ["pages.xml", "campaigns.xml", ...Array.from({ length: files }, (_, i) => `organizations-${i}.xml`)];
}

export function pageUrls(origin: string): SitemapUrl[] {
  return LOCALES.flatMap((l) => STATIC_PAGES.map((p) => ({ loc: `${origin}/${l}${p}` })));
}

export async function campaignUrls(db: Database, origin: string): Promise<SitemapUrl[]> {
  const rows = (await db.execute(sql`
    select c.slug, coalesce(c.updated_at, c.created_at) as at from app.campaigns c
    where c.status = 'DEPLOYED' and c.onchain_address is not null and not c.is_demo
    order by c.id
  `)) as unknown as { slug: string; at: Date | string }[];
  return LOCALES.flatMap((l) => rows.map((r) => ({ loc: `${origin}/${l}/campaigns/${encodeURIComponent(r.slug)}`, lastmod: day(r.at) })));
}

/** One file of organisation profiles, in id order (`page` from 0). */
export async function organizationUrls(db: Database, origin: string, page: number): Promise<SitemapUrl[]> {
  const rows = (await db.execute(sql`
    select t.org_id, t.computed_at from app.trust_scores t
    where t.version = ${TRUST_SCORE_VERSION} and t.listed
    order by t.org_id
    limit ${ORGS_PER_FILE} offset ${page * ORGS_PER_FILE}
  `)) as unknown as { org_id: string; computed_at: Date | string }[];
  return LOCALES.flatMap((l) => rows.map((r) => ({ loc: `${origin}/${l}/charity-market-cap/${r.org_id}`, lastmod: day(r.computed_at) })));
}

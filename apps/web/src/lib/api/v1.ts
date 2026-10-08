import { parseAppEnv } from "@cherrio/shared";
import type { MarketCapRow } from "@/lib/market-cap/list";
import type { MarketCapProfile } from "@/lib/market-cap/profile";
import type { PublicCampaign, PublicCampaignSummary } from "@/lib/campaigns/public";
import type { RatingSummary } from "@/lib/ratings";
import { getClientIp, MemoryRateLimiter, type RateLimitOptions } from "@/lib/security/rate-limit";
import { getExpectedOrigin } from "@/lib/security/origin";

// Public read API v1 (TASK-018b). Read-only, no login, no personal data.
// JSON with CORS for any origin (GET only), a per-IP limit, short public
// caching. Money is a string of base units (USDC: 6 decimals) — never a float.

export const API_RATE_LIMIT: RateLimitOptions = { windowMs: 60_000, maxRequests: 120 };
export const apiRateLimiter = new MemoryRateLimiter();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function apiJson(body: unknown, init: { status?: number; maxAge?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": init.status && init.status >= 400 ? "no-store" : `public, max-age=${init.maxAge ?? 60}`,
      ...CORS,
      ...init.headers,
    },
  });
}

export function apiError(code: string, status: number, headers?: Record<string, string>): Response {
  return apiJson({ error: code }, { status, headers });
}

export function apiOptions(): Response {
  return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Max-Age": "86400" } });
}

/** null when the request may go on; otherwise the 429 to return. */
export function apiLimit(request: Request): Response | null {
  const r = apiRateLimiter.check(getClientIp(request), API_RATE_LIMIT);
  if (r.success) return null;
  return apiError("rate_limited", 429, { "Retry-After": String(r.reset) });
}

export const siteOrigin = () => getExpectedOrigin(parseAppEnv(process.env.APP_ENV ?? "local"));

export interface ApiOrganizationSummary {
  id: string;
  name: string;
  country: string | null;
  causes: string[];
  trustScore: string;
  onCherrio: boolean;
  /** USDC base units (6 decimals) raised on CHERR.IO. */
  raisedUsdc: string;
  url: string;
}

export function organizationSummary(row: MarketCapRow, origin: string): ApiOrganizationSummary & { position: number } {
  return {
    id: row.orgId,
    position: row.position,
    name: row.name,
    country: row.country,
    causes: row.causes,
    trustScore: row.score,
    onCherrio: row.registered,
    raisedUsdc: row.raised.toString(),
    url: `${origin}/en/charity-market-cap/${row.orgId}`,
  };
}

/** Register fields we publish; the import never stores contact details. */
const REGISTER_FIELDS = [
  "status", "registeredOn", "removedOn", "financialYearEnd", "income", "expenditure",
  "city", "state", "ruling", "taxPeriod", "revenue", "assets", "ntee",
] as const;

export function organizationDetail(p: MarketCapProfile, rating: RatingSummary | undefined, origin: string) {
  const raw = p.registryRecord ?? {};
  const facts = Object.fromEntries(REGISTER_FIELDS.filter((k) => raw[k] !== undefined && raw[k] !== null).map((k) => [k, raw[k]]));
  return {
    id: p.id,
    name: p.name,
    country: p.country,
    causes: p.causes,
    website: p.website,
    description: p.description,
    onCherrio: p.registered,
    claimable: p.claimable,
    trustScore: { score: p.score, version: 1, components: p.components, computedAt: p.computedAt.toISOString() },
    ratings: rating ? { average: rating.average, count: rating.count } : { average: null, count: 0 },
    raisedUsdc: p.raised.toString(),
    register: p.registry === "NONE" ? null : { name: p.registry, id: p.registryId, facts },
    url: `${origin}/en/charity-market-cap/${p.id}`,
  };
}

export function campaignSummary(c: PublicCampaignSummary, origin: string) {
  return {
    id: c.id,
    slug: c.slug,
    title: c.title,
    organization: { id: c.orgId, name: c.orgName, verified: c.orgVerified },
    cause: c.cause,
    country: c.country,
    target: { eurCents: c.targetEurCents.toString(), usdc: c.targetUsdc.toString() },
    deadline: c.deadline.toISOString(),
    contract: c.address,
    demo: c.isDemo,
    state: c.onChain?.state ?? null,
    raisedUsdc: c.onChain ? c.onChain.raised.toString() : null,
    donors: c.onChain?.donors ?? null,
    payoutMode: c.onChain?.payoutMode ?? null,
    url: `${origin}/en/campaigns/${encodeURIComponent(c.slug)}`,
  };
}

export function campaignDetail(c: PublicCampaign, origin: string) {
  return { ...campaignSummary(c, origin), story: c.story };
}

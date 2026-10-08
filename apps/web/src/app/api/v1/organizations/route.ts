/**
 * GET /api/v1/organizations — the Charity Market Cap as JSON (TASK-018b).
 * Same filters and order as the page: q, country, cause, on=cherrio|other,
 * sort=score|raised|name, limit 1–100 (default 25), after=<cursor from `next`>.
 */
import { getDb } from "@/lib/db";
import { apiJson, apiLimit, apiOptions, organizationSummary, siteOrigin } from "@/lib/api/v1";
import { listMarketCap, parseMarketCapQuery } from "@/lib/market-cap/list";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const limited = apiLimit(request);
  if (limited) return limited;
  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams.entries());
  const query = parseMarketCapQuery(params);
  const limit = Math.min(100, Math.max(1, Number.parseInt(params.limit ?? "25", 10) || 25));
  const { rows, next } = await listMarketCap(getDb(), query, limit);
  const origin = siteOrigin();
  const nextParams = new URLSearchParams(url.searchParams);
  if (next) nextParams.set("after", next);
  return apiJson({
    data: rows.map((r) => organizationSummary(r, origin)),
    next: next,
    nextUrl: next ? `${origin}/api/v1/organizations?${nextParams.toString()}` : null,
  });
}

export const OPTIONS = apiOptions;

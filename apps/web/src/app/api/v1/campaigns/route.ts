/**
 * GET /api/v1/campaigns — published campaigns (TASK-018b): cause, country
 * (repeatable), q, sort=ending|newest|raised, page (24 per page).
 */
import { getDb } from "@/lib/db";
import { apiJson, apiLimit, apiOptions, campaignSummary, siteOrigin } from "@/lib/api/v1";
import { parseCampaignSort } from "@/lib/campaigns/filter-options";
import { listPublicCampaigns, parseCampaignFilters } from "@/lib/campaigns/public";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const limited = apiLimit(request);
  if (limited) return limited;
  const sp = new URL(request.url).searchParams;
  const all = (k: string) => (sp.getAll(k).length > 1 ? sp.getAll(k) : (sp.get(k) ?? undefined));
  const filters = parseCampaignFilters({ cause: all("cause"), country: all("country"), q: sp.get("q") ?? undefined });
  const result = await listPublicCampaigns(getDb(), {
    page: Number(sp.get("page") ?? "1"),
    sort: parseCampaignSort(sp.get("sort") ?? undefined),
    ...filters,
  });
  const origin = siteOrigin();
  return apiJson({
    data: result.campaigns.map((c) => campaignSummary(c, origin)),
    page: result.page,
    pageCount: result.pageCount,
    total: result.total,
    chainAvailable: result.chainAvailable,
  });
}

export const OPTIONS = apiOptions;

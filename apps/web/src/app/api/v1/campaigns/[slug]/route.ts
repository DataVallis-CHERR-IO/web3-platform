/** GET /api/v1/campaigns/{slug} — one published campaign with its story (TASK-018b). */
import { getDb } from "@/lib/db";
import { apiError, apiJson, apiLimit, apiOptions, campaignDetail, siteOrigin } from "@/lib/api/v1";
import { getPublicCampaign } from "@/lib/campaigns/public";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const limited = apiLimit(request);
  if (limited) return limited;
  const { slug } = await params;
  if (!/^[a-z0-9-]{1,200}$/.test(slug)) return apiError("not_found", 404);
  const found = await getPublicCampaign(getDb(), slug);
  if (!found) return apiError("not_found", 404);
  return apiJson({ data: campaignDetail(found.campaign, siteOrigin()) });
}

export const OPTIONS = apiOptions;

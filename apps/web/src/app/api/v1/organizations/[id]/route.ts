/** GET /api/v1/organizations/{id} — one listed organisation with its Trust Score parts (TASK-018b). */
import { getDb } from "@/lib/db";
import { apiError, apiJson, apiLimit, apiOptions, organizationDetail, siteOrigin } from "@/lib/api/v1";
import { getMarketCapProfile } from "@/lib/market-cap/profile";
import { orgRatingSummaries } from "@/lib/ratings";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const limited = apiLimit(request);
  if (limited) return limited;
  const { id } = await params;
  const db = getDb();
  const profile = await getMarketCapProfile(db, id);
  if (!profile) return apiError("not_found", 404);
  const ratings = await orgRatingSummaries(db, [profile.id]);
  return apiJson({ data: organizationDetail(profile, ratings.get(profile.id), siteOrigin()) }, { maxAge: 300 });
}

export const OPTIONS = apiOptions;

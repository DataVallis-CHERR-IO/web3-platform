import { z } from "zod";
import { getDb } from "@/lib/db";
import { getClientIp } from "@/lib/security/rate-limit";
import { rejectCampaign } from "@/lib/campaigns/review";
import { handleCampaignReview } from "@/lib/campaigns/review-route";

export const dynamic = "force-dynamic";

/** The note is shown to the organisation. */
const bodySchema = z.object({ note: z.string().trim().min(10).max(1000) });

/** POST /api/admin/campaigns/:id/reject — PLATFORM_ADMIN only. */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleCampaignReview(request, params, bodySchema, (reviewerId, campaignId, body) =>
    rejectCampaign(getDb(), reviewerId, campaignId, body.note, getClientIp(request))
  );
}

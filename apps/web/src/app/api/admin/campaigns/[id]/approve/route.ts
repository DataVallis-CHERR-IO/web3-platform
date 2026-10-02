import { z } from "zod";
import { getDb } from "@/lib/db";
import { getClientIp } from "@/lib/security/rate-limit";
import { approveCampaign } from "@/lib/campaigns/review";
import { handleCampaignReview } from "@/lib/campaigns/review-route";

export const dynamic = "force-dynamic";

/** No input: the rate comes from the ECB, the payout address from the verified organisation. */
const bodySchema = z.object({}).strict();

/** POST /api/admin/campaigns/:id/approve — PLATFORM_ADMIN only. */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleCampaignReview(request, params, bodySchema, (reviewerId, campaignId) =>
    approveCampaign(getDb(), reviewerId, campaignId, { ip: getClientIp(request) })
  );
}

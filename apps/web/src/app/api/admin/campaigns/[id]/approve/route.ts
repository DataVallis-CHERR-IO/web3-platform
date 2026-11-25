import { z } from "zod";
import { getDb } from "@/lib/db";
import { getClientIp } from "@/lib/security/rate-limit";
import { approveCampaign } from "@/lib/campaigns/review";
import { handleCampaignReview } from "@/lib/campaigns/review-route";

export const dynamic = "force-dynamic";

/**
 * The rate comes from the ECB, the payout address from the verified organisation; the only
 * input is an optional note for audit_log (the staff agent sends its check verdict, TASK-061e).
 */
const bodySchema = z.object({ note: z.string().trim().min(1).max(500).optional() }).strict();

/** POST /api/admin/campaigns/:id/approve — PLATFORM_ADMIN only. */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleCampaignReview(request, params, bodySchema, (reviewerId, campaignId, body) =>
    approveCampaign(getDb(), reviewerId, campaignId, { ip: getClientIp(request), note: body.note })
  );
}

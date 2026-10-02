import { z } from "zod";
import { getDb } from "@/lib/db";
import { getClientIp } from "@/lib/security/rate-limit";
import { recordPublishTx } from "@/lib/campaigns/publish";
import { handleCampaignReview } from "@/lib/campaigns/review-route";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict();

/** POST /api/admin/campaigns/:id/publish/sent — PLATFORM_ADMIN only; stores the createCampaign transaction hash. */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleCampaignReview(request, params, bodySchema, (adminId, campaignId, body) =>
    recordPublishTx(getDb(), adminId, campaignId, body.txHash, getClientIp(request))
  );
}

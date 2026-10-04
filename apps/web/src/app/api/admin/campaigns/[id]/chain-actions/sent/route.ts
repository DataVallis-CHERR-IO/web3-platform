import { z } from "zod";
import { getDb } from "@/lib/db";
import { getClientIp } from "@/lib/security/rate-limit";
import { recordChainSent } from "@/lib/admin/guardian";
import { handleCampaignReview } from "@/lib/campaigns/review-route";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  requestId: z.string().uuid(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

/** POST /api/admin/campaigns/:id/chain-actions/sent — PLATFORM_ADMIN only: links the transaction to the request. */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleCampaignReview(request, params, bodySchema, (adminId, campaignId, body) =>
    recordChainSent(getDb(), adminId, campaignId, body, getClientIp(request))
  );
}

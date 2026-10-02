import { z } from "zod";
import { getDb } from "@/lib/db";
import { linkDeployedCampaign, publishDeployment } from "@/lib/campaigns/publish";
import { handleCampaignReview } from "@/lib/campaigns/review-route";

export const dynamic = "force-dynamic";

const bodySchema = z.object({}).strict();

/** POST /api/admin/campaigns/:id/publish/check — PLATFORM_ADMIN only; links the campaign once the indexer has it. */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleCampaignReview(request, params, bodySchema, (adminId, campaignId) =>
    linkDeployedCampaign(getDb(), adminId, campaignId, publishDeployment())
  );
}

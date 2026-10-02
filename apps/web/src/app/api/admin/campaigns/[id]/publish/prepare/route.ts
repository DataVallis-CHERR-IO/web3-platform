import { z } from "zod";
import { getDb } from "@/lib/db";
import { preparePublish, publishDeployment } from "@/lib/campaigns/publish";
import { handleCampaignReview } from "@/lib/campaigns/review-route";

export const dynamic = "force-dynamic";

const bodySchema = z.object({}).strict();

/** POST /api/admin/campaigns/:id/publish/prepare — PLATFORM_ADMIN only; the createCampaign call to sign. */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleCampaignReview(request, params, bodySchema, (adminId, campaignId) =>
    preparePublish(getDb(), adminId, campaignId, publishDeployment())
  );
}

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/files/storage";
import { getClientIp } from "@/lib/security/rate-limit";
import { submitDraft } from "@/lib/campaigns/drafts";
import { campaignError } from "@/lib/campaigns/errors";
import { withDraftAccess } from "@/lib/campaigns/route";

export const dynamic = "force-dynamic";

/** POST /api/campaigns/:id/submit — send a draft (or a rejected campaign) to review. */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withDraftAccess(request, async (userId) => {
    const { id } = await params;
    if (!isUuid(id)) return campaignError("not_found", 404);
    await submitDraft(getDb(), userId, id, getClientIp(request));
    return NextResponse.json({ id, status: "PENDING_REVIEW" });
  });
}

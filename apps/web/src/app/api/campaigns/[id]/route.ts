import { NextResponse } from "next/server";
import { campaignDraftSchema } from "@cherrio/shared";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/files/storage";
import { updateDraft } from "@/lib/campaigns/drafts";
import { campaignError } from "@/lib/campaigns/errors";
import { parseBody, withDraftAccess } from "@/lib/campaigns/route";

export const dynamic = "force-dynamic";

/** PATCH /api/campaigns/:id — edit a campaign while it is DRAFT or REJECTED. */
export function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withDraftAccess(request, async (userId) => {
    const { id } = await params;
    if (!isUuid(id)) return campaignError("not_found", 404);
    const body = await parseBody(request, campaignDraftSchema);
    if ("response" in body) return body.response;
    return NextResponse.json(await updateDraft(getDb(), userId, id, body.data));
  });
}

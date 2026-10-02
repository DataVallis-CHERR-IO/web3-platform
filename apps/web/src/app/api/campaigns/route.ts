import { NextResponse } from "next/server";
import { newCampaignDraftSchema } from "@cherrio/shared";
import { getDb } from "@/lib/db";
import { createDraft } from "@/lib/campaigns/drafts";
import { parseBody, withDraftAccess } from "@/lib/campaigns/route";

export const dynamic = "force-dynamic";

/** POST /api/campaigns — create a campaign draft for an approved organisation the user administers. */
export function POST(request: Request) {
  return withDraftAccess(request, async (userId) => {
    const body = await parseBody(request, newCampaignDraftSchema);
    if ("response" in body) return body.response;
    const { organizationId, ...draft } = body.data;
    return NextResponse.json(await createDraft(getDb(), userId, organizationId, draft), { status: 201 });
  });
}

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/files/storage";
import { removeMedia } from "@/lib/campaigns/media";
import { withMediaAccess } from "@/lib/campaigns/media-route";
import { campaignError } from "@/lib/campaigns/errors";

export const dynamic = "force-dynamic";

/** DELETE /api/campaigns/:id/media/:mediaId — the organisation removes one item (not the cover). */
export function DELETE(request: Request, { params }: { params: Promise<{ id: string; mediaId: string }> }) {
  return withMediaAccess(request, async (userId, ip) => {
    const { id, mediaId } = await params;
    if (!isUuid(id) || !isUuid(mediaId)) return campaignError("not_found", 404);
    await removeMedia(getDb(), userId, id, mediaId, "owner", ip);
    return new NextResponse(null, { status: 204 });
  });
}

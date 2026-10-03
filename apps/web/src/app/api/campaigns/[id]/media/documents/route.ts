import { NextResponse } from "next/server";
import { CAMPAIGN_MEDIA_LIMITS } from "@cherrio/shared";
import { getDb } from "@/lib/db";
import { addDocument } from "@/lib/campaigns/media";
import { withMediaUpload } from "@/lib/campaigns/media-route";
import { publicMediaUrl } from "@/lib/media/public-store";

export const dynamic = "force-dynamic";

/** POST /api/campaigns/:id/media/documents — one public PDF (multipart `file`, ≤ 20 MB), any status (ADR-039). */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withMediaUpload(request, params, CAMPAIGN_MEDIA_LIMITS.documentBytes, async (userId, campaignId, file, ip) => {
    const { id, key, label } = await addDocument(getDb(), userId, campaignId, Buffer.from(await file.arrayBuffer()), file.name, ip);
    return NextResponse.json({ id, url: publicMediaUrl(key), label }, { status: 201 });
  });
}

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { addGalleryImage } from "@/lib/campaigns/media";
import { withMediaUpload } from "@/lib/campaigns/media-route";
import { MAX_IMAGE_BYTES } from "@/lib/media/image";
import { publicMediaUrl } from "@/lib/media/public-store";

export const dynamic = "force-dynamic";

/** POST /api/campaigns/:id/media/images — one gallery image (multipart `file`), any campaign status (ADR-039). */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withMediaUpload(request, params, MAX_IMAGE_BYTES, async (userId, campaignId, file, ip) => {
    const { id, key } = await addGalleryImage(getDb(), userId, campaignId, Buffer.from(await file.arrayBuffer()), ip);
    return NextResponse.json({ id, url: publicMediaUrl(key) }, { status: 201 });
  });
}

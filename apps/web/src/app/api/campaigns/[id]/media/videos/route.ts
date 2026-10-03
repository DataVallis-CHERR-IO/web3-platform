import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/files/storage";
import { addVideo } from "@/lib/campaigns/media";
import { withMediaAccess } from "@/lib/campaigns/media-route";
import { parseBody } from "@/lib/campaigns/route";
import { campaignError } from "@/lib/campaigns/errors";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ url: z.string().trim().min(1).max(500) }).strict();

/** POST /api/campaigns/:id/media/videos — a YouTube or Vimeo link (ADR-039). */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withMediaAccess(request, async (userId, ip) => {
    const { id } = await params;
    if (!isUuid(id)) return campaignError("not_found", 404);
    const body = await parseBody(request, bodySchema);
    if ("response" in body) return body.response;
    const { id: mediaId, video } = await addVideo(getDb(), userId, id, body.data.url, ip);
    return NextResponse.json({ id: mediaId, video }, { status: 201 });
  });
}

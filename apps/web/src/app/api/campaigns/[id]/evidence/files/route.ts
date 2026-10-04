import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { campaignError } from "@/lib/campaigns/errors";
import { addEvidenceFile, EVIDENCE_LIMITS } from "@/lib/campaigns/evidence";
import { withMediaUpload } from "@/lib/campaigns/media-route";

export const dynamic = "force-dynamic";

/**
 * POST /api/campaigns/:id/evidence/files?visibility=private|public — one file
 * (multipart `file`, ≤ 10 MB) for the open round's draft (TASK-033c, ADR-047).
 * Private: PDF/JPEG/PNG, encrypted. Public: PDF unchanged, or an image re-encoded without metadata.
 */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const visibility = new URL(request.url).searchParams.get("visibility");
  return withMediaUpload(request, params, EVIDENCE_LIMITS.fileBytes, async (userId, campaignId, file, ip) => {
    if (visibility !== "private" && visibility !== "public") return campaignError("bad_request", 400);
    const added = await addEvidenceFile(
      getDb(), userId, campaignId, Buffer.from(await file.arrayBuffer()), visibility === "private" ? "PRIVATE" : "PUBLIC", ip
    );
    return NextResponse.json(added, { status: 201 });
  });
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { isUuid } from "@/lib/files/storage";
import { campaignError } from "@/lib/campaigns/errors";
import { DraftRefusedError } from "@/lib/campaigns/drafts";
import { EVIDENCE_LIMITS, listOwnEvidence, setEvidenceNote } from "@/lib/campaigns/evidence";
import { parseBody } from "@/lib/campaigns/route";
import { withMediaAccess } from "@/lib/campaigns/media-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** GET /api/campaigns/:id/evidence — the organisation's admins: every bundle (drafts too) and the round open now (TASK-033c). */
export async function GET(request: Request, { params }: Params) {
  const session = await getSession(request);
  if (!session) return campaignError("unauthorized", 401);
  const { id } = await params;
  if (!isUuid(id)) return campaignError("not_found", 404);
  try {
    return NextResponse.json(await listOwnEvidence(getDb(), session.userId, id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof DraftRefusedError) return campaignError("not_found", 404);
    throw error;
  }
}

const noteSchema = z.object({ note: z.string().trim().max(EVIDENCE_LIMITS.noteChars) });

/** PUT /api/campaigns/:id/evidence — `{ note }`: the public note of the open round's draft. */
export function PUT(request: Request, { params }: Params) {
  return withMediaAccess(request, async (userId, ip) => {
    const { id } = await params;
    if (!isUuid(id)) return campaignError("not_found", 404);
    const body = await parseBody(request, noteSchema);
    if ("response" in body) return body.response;
    await setEvidenceNote(getDb(), userId, id, body.data.note, ip);
    return new NextResponse(null, { status: 204 });
  });
}

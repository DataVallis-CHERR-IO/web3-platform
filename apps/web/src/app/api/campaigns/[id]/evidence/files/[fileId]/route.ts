import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { isUuid } from "@/lib/files/storage";
import { getClientIp } from "@/lib/security/rate-limit";
import { campaignError } from "@/lib/campaigns/errors";
import { DraftRefusedError } from "@/lib/campaigns/drafts";
import { openPrivateEvidenceFile, removeEvidenceFile } from "@/lib/campaigns/evidence";
import { withMediaAccess } from "@/lib/campaigns/media-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; fileId: string }> };
const EXTENSIONS: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" };

/**
 * GET /api/campaigns/:id/evidence/files/:fileId — a private evidence file,
 * decrypted, for the organisation's admins only (ADR-047); every download is
 * audited. Everyone else gets 404. Platform admins use /api/admin/files/:id.
 */
export async function GET(request: Request, { params }: Params) {
  const notFound = () => new NextResponse(null, { status: 404 });
  const session = await getSession(request);
  if (!session) return notFound();
  const { id, fileId } = await params;
  if (!isUuid(id) || !isUuid(fileId)) return notFound();
  let file: Awaited<ReturnType<typeof openPrivateEvidenceFile>>;
  try {
    file = await openPrivateEvidenceFile(getDb(), session.userId, id, fileId, getClientIp(request));
  } catch (error) {
    if (error instanceof DraftRefusedError) return notFound();
    throw error;
  }
  if (!file) return notFound();
  return new NextResponse(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(file.bytes.length),
      "Content-Disposition": `attachment; filename="evidence-${fileId.slice(-8)}.${EXTENSIONS[file.mimeType] ?? "bin"}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** DELETE /api/campaigns/:id/evidence/files/:fileId — removes a file from the open, unsealed draft. */
export function DELETE(request: Request, { params }: Params) {
  return withMediaAccess(request, async (userId, ip) => {
    const { id, fileId } = await params;
    if (!isUuid(id) || !isUuid(fileId)) return campaignError("not_found", 404);
    await removeEvidenceFile(getDb(), userId, id, fileId, ip);
    return new NextResponse(null, { status: 204 });
  });
}

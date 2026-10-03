import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/files/storage";
import { MediaRefusedError, removeMedia } from "@/lib/campaigns/media";
import { verifyOrigin } from "@/lib/security/origin";
import { getClientIp } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/admin/campaigns/:id/media/:mediaId — takedown of one media item by a
 * platform admin (ADR-039; unlawful or personal content). 404 for everyone else. Audited.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; mediaId: string }> }) {
  const notFound = () => new NextResponse(null, { status: 404 });
  let adminId: string;
  try {
    adminId = (await requireRole("PLATFORM_ADMIN", request)).userId;
  } catch {
    return notFound();
  }
  if (!verifyOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id, mediaId } = await params;
  if (!isUuid(id) || !isUuid(mediaId)) return notFound();
  try {
    await removeMedia(getDb(), adminId, id, mediaId, "platform_admin", getClientIp(request));
  } catch (error) {
    if (error instanceof MediaRefusedError) return notFound();
    throw error;
  }
  return new NextResponse(null, { status: 204 });
}

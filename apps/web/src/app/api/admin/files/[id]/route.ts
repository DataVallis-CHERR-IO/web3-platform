import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { auditLog, privateFiles } from "@cherrio/db";
import { getDb } from "@/lib/db";
import { requireRole, type SessionPayload } from "@/lib/auth/session";
import { getClientIp } from "@/lib/security/rate-limit";
import { getPrivateFile, isUuid } from "@/lib/files/storage";

export const dynamic = "force-dynamic";

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

/**
 * GET /api/admin/files/:id — PLATFORM_ADMIN only (role re-read from the DB, ADR-028).
 * Everyone else gets 404, as if the route did not exist. Every download is
 * written to audit_log before the file is sent (ADR-033).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const notFound = () => new NextResponse(null, { status: 404 });

  let session: SessionPayload;
  try {
    session = await requireRole("PLATFORM_ADMIN", request);
  } catch {
    return notFound();
  }
  const { id } = await params;
  if (!isUuid(id)) return notFound();

  const db = getDb();
  const [file] = await db
    .select({ storageKey: privateFiles.storageKey, kind: privateFiles.kind, mimeType: privateFiles.mimeType })
    .from(privateFiles)
    .where(and(eq(privateFiles.id, id), isNull(privateFiles.deletedAt)))
    .limit(1);
  if (!file) return notFound();

  // Throws (→ 500) if the object cannot be verified; unverified bytes are never sent.
  const bytes = await getPrivateFile(file.storageKey);
  if (!bytes) return notFound();

  await db.insert(auditLog).values({
    actorUserId: session.userId,
    action: "private_file.download",
    entityType: "private_file",
    entityId: id,
    data: { kind: file.kind },
    ip: getClientIp(request),
  });

  const filename = `${file.kind.toLowerCase()}-${id.slice(-8)}.${EXTENSIONS[file.mimeType] ?? "bin"}`;
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { privateFiles } from "@cherrio/db";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { verifyOrigin } from "@/lib/security/origin";
import { filesError } from "@/lib/files/errors";
import { isUuid, removeStoredObject } from "@/lib/files/storage";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/files/kyb/:id — only the uploader, only while the file is unattached.
 * The row is marked deleted first; the object is deleted after that. If the
 * object delete fails it is left for `files:sweep`.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!verifyOrigin(request)) return filesError("forbidden", 403);
  const session = await getSession(request);
  if (!session) return filesError("unauthorized", 401);

  const { id } = await params;
  if (!isUuid(id)) return filesError("not_found", 404);

  const db = getDb();
  const own = and(
    eq(privateFiles.id, id),
    eq(privateFiles.uploadedBy, session.userId),
    isNull(privateFiles.deletedAt)
  );
  const [file] = await db
    .select({ kybSubmissionId: privateFiles.kybSubmissionId })
    .from(privateFiles)
    .where(own)
    .limit(1);
  if (!file) return filesError("not_found", 404);
  if (file.kybSubmissionId) return filesError("file_attached", 409);

  const [marked] = await db
    .update(privateFiles)
    .set({ deletedAt: new Date() })
    .where(and(own, isNull(privateFiles.kybSubmissionId)))
    .returning({ storageKey: privateFiles.storageKey });
  if (!marked) return filesError("file_attached", 409); // attached in the meantime

  await removeStoredObject(marked.storageKey);
  return new NextResponse(null, { status: 204 });
}

import { NextResponse } from "next/server";
import { and, count, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { newId, privateFiles } from "@cherrio/db";
import { KYB_DOCUMENT_RULES, type KybDocumentKind } from "@cherrio/shared";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { verifyOrigin } from "@/lib/security/origin";
import { FILES_RATE_LIMIT, filesRateLimiter } from "@/lib/security/rate-limit";
import { filesError } from "@/lib/files/errors";
import { FileRejectedError, MAX_FILE_BYTES } from "@/lib/files/file-type";
import { kybStorageKey, putPrivateFile, removeStoredObject, type StoredPrivateFile } from "@/lib/files/storage";
import { tryAcquireUploadSlot } from "@/lib/files/upload-slots";

export const dynamic = "force-dynamic";

/** Room for the multipart boundaries and the `kind` field around a 10 MB file. */
const MULTIPART_ALLOWANCE_BYTES = 64 * 1024;
const MAX_UNATTACHED_FILES = 10;
// KYB kinds only: evidence files have their own route (TASK-033c).
const kindSchema = z.enum(Object.keys(KYB_DOCUMENT_RULES) as [KybDocumentKind, ...KybDocumentKind[]]);

/**
 * POST /api/files/kyb — multipart: one `file` and its `kind`.
 * The file is checked (magic bytes, size), hashed and encrypted before it is
 * stored (ADR-033). It stays unattached until the application is submitted.
 */
export async function POST(request: Request) {
  if (!verifyOrigin(request)) return filesError("forbidden", 403);
  const session = await getSession(request);
  if (!session) return filesError("unauthorized", 401);

  const limit = filesRateLimiter.check(`files:${session.userId}`, FILES_RATE_LIMIT);
  if (!limit.success) return filesError("rate_limited", 429, { "Retry-After": String(limit.reset) });

  // Refuse by declared size before any of the body is read.
  const contentLength = request.headers.get("content-length");
  if (!contentLength || !/^\d+$/.test(contentLength)) return filesError("length_required", 411);
  if (Number(contentLength) > MAX_FILE_BYTES + MULTIPART_ALLOWANCE_BYTES) return filesError("file_too_large", 413);

  const release = tryAcquireUploadSlot();
  if (!release) return filesError("busy", 503, { "Retry-After": "5" });
  try {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return filesError("bad_request", 400);
    }
    const kind = kindSchema.safeParse(form.get("kind"));
    const file = form.get("file");
    if (!kind.success || !(file instanceof File)) return filesError("bad_request", 400);
    if (file.size > MAX_FILE_BYTES) return filesError("file_too_large", 413);

    const id = newId();
    const storageKey = kybStorageKey(id);
    let stored: StoredPrivateFile;
    try {
      stored = await putPrivateFile({ storageKey, bytes: Buffer.from(await file.arrayBuffer()) });
    } catch (error) {
      if (!(error instanceof FileRejectedError)) throw error;
      return filesError(error.code, error.code === "file_too_large" ? 413 : 400);
    }

    let inserted: boolean;
    try {
      inserted = await getDb().transaction(async (tx) => {
        // One upload per user at a time in this section, so the limit cannot be passed by parallel requests.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${session.userId}))`);
        const [unattached] = await tx
          .select({ n: count() })
          .from(privateFiles)
          .where(
            and(
              eq(privateFiles.uploadedBy, session.userId),
              isNull(privateFiles.kybSubmissionId),
              isNull(privateFiles.deletedAt),
              ne(privateFiles.kind, "EVIDENCE")
            )
          );
        if ((unattached?.n ?? 0) >= MAX_UNATTACHED_FILES) return false;
        await tx.insert(privateFiles).values({
          id,
          storageKey,
          kind: kind.data,
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          keyVersion: stored.keyVersion,
          uploadedBy: session.userId,
        });
        return true;
      });
    } catch (error) {
      await removeStoredObject(storageKey); // no row exists for it
      throw error;
    }
    if (!inserted) {
      await removeStoredObject(storageKey);
      return filesError("too_many_files", 409);
    }
    return NextResponse.json({ id, kind: kind.data, sizeBytes: stored.sizeBytes }, { status: 201 });
  } finally {
    release();
  }
}

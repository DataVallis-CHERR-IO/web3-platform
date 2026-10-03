import type { NextResponse } from "next/server";
import { isUuid } from "@/lib/files/storage";
import { tryAcquireUploadSlot } from "@/lib/files/upload-slots";
import { getClientIp, MEDIA_RATE_LIMIT, mediaRateLimiter } from "@/lib/security/rate-limit";
import { campaignError } from "./errors";
import { withDraftAccess } from "./route";

/** Framing of a multipart body around the file. */
const MULTIPART_ALLOWANCE_BYTES = 64 * 1024;

/**
 * Frame of the media upload routes (ADR-039): origin, session, 30/min per user,
 * Content-Length required and capped before the body is read, one of two
 * upload slots per container, then the multipart `file`.
 */
export function withMediaUpload(
  request: Request,
  params: Promise<{ id: string }>,
  maxFileBytes: number,
  handler: (userId: string, campaignId: string, file: File, ip: string | undefined) => Promise<NextResponse>
) {
  return withDraftAccess(
    request,
    async (userId) => {
      const { id } = await params;
      if (!isUuid(id)) return campaignError("not_found", 404);
      const contentLength = request.headers.get("content-length");
      if (!contentLength || !/^\d+$/.test(contentLength)) return campaignError("length_required", 411);
      if (Number(contentLength) > maxFileBytes + MULTIPART_ALLOWANCE_BYTES) return campaignError("file_too_large", 413);

      const release = tryAcquireUploadSlot();
      if (!release) return campaignError("busy", 503, { retryAfter: 5 });
      try {
        const file = (await request.formData().catch(() => null))?.get("file");
        if (!(file instanceof File)) return campaignError("bad_request", 400);
        return await handler(userId, id, file, getClientIp(request));
      } finally {
        release();
      }
    },
    { limiter: mediaRateLimiter, options: MEDIA_RATE_LIMIT }
  );
}

/** Frame of the JSON media routes (video link, remove). */
export function withMediaAccess(request: Request, handler: (userId: string, ip: string | undefined) => Promise<NextResponse>) {
  return withDraftAccess(request, (userId) => handler(userId, getClientIp(request)), {
    limiter: mediaRateLimiter,
    options: MEDIA_RATE_LIMIT,
  });
}

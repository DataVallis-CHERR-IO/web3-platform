import type { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { verifyOrigin } from "@/lib/security/origin";
import { APPLICATION_RATE_LIMIT, applicationRateLimiter, type RateLimitOptions } from "@/lib/security/rate-limit";
import { FileRejectedError } from "@/lib/files/file-type";
import { DraftRefusedError } from "./drafts";
import { MediaRefusedError } from "./media";
import { EvidenceRefusedError } from "./evidence";
import { campaignError } from "./errors";

/**
 * Shared frame of the campaign draft handlers: origin check, session, rate
 * limit (10/min per user), and the mapping of refusals to responses.
 */
export async function withDraftAccess(
  request: Request,
  handler: (userId: string) => Promise<NextResponse>,
  limit: { limiter: { check: (key: string, options: RateLimitOptions) => { success: boolean } }; options: RateLimitOptions } = {
    limiter: applicationRateLimiter,
    options: APPLICATION_RATE_LIMIT,
  }
): Promise<NextResponse> {
  if (!verifyOrigin(request)) return campaignError("forbidden", 403);
  const session = await getSession(request);
  if (!session) return campaignError("unauthorized", 401);
  if (!limit.limiter.check(`campaign:${session.userId}`, limit.options).success) {
    return campaignError("rate_limited", 429);
  }
  try {
    return await handler(session.userId);
  } catch (error) {
    if (error instanceof DraftRefusedError) return campaignError(error.code, error.code === "not_found" ? 404 : 409);
    if (error instanceof FileRejectedError) return campaignError(error.code, error.code === "file_too_large" ? 413 : 400);
    if (error instanceof MediaRefusedError) {
      return campaignError(error.code, error.code === "media_not_found" ? 404 : error.code === "video_url_invalid" ? 400 : 409);
    }
    if (error instanceof EvidenceRefusedError) return campaignError(error.code, error.code === "evidence_file_not_found" ? 404 : 409);
    throw error;
  }
}

/** Parses a JSON body with a zod schema; on failure returns the names of the invalid fields. */
export async function parseBody<T>(
  request: Request,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[] }[] } } }
): Promise<{ data: T } | { response: NextResponse }> {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (parsed.success) return { data: parsed.data };
  const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "")))];
  return { response: campaignError("validation_failed", 400, { fields }) };
}

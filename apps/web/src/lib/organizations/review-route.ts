import { NextResponse } from "next/server";
import type { z } from "zod";
import { requireRole } from "@/lib/auth/session";
import { verifyOrigin } from "@/lib/security/origin";
import { isUuid } from "@/lib/files/storage";
import { ReviewRefusedError } from "./review";

/**
 * Every error the KYB review routes can return besides 404. The response
 * carries only the code; the text is the next-intl message `admin.kyb.errors.<code>`.
 */
export const REVIEW_ERROR_CODES = [
  "forbidden",
  "validation_failed",
  "not_pending",
  "self_review",
  "application_invalid",
  "payout_address_mismatch",
] as const;
type ReviewErrorCode = (typeof REVIEW_ERROR_CODES)[number];

const error = (code: ReviewErrorCode, status: number) => NextResponse.json({ error: code }, { status });

/**
 * Shared frame of the approve and reject handlers: PLATFORM_ADMIN re-read from
 * the DB (404 for everyone else, as if the route did not exist), origin check,
 * body validation, and the mapping of refusals to responses.
 */
export async function handleReview<T>(
  request: Request,
  params: Promise<{ submissionId: string }>,
  bodySchema: z.ZodType<T>,
  action: (reviewerId: string, submissionId: string, body: T) => Promise<unknown>
) {
  const notFound = () => new NextResponse(null, { status: 404 });
  let reviewerId: string;
  try {
    reviewerId = (await requireRole("PLATFORM_ADMIN", request)).userId;
  } catch {
    return notFound();
  }
  if (!verifyOrigin(request)) return error("forbidden", 403);
  const { submissionId } = await params;
  if (!isUuid(submissionId)) return notFound();

  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return error("validation_failed", 400);

  try {
    return NextResponse.json(await action(reviewerId, submissionId, body.data));
  } catch (e) {
    if (!(e instanceof ReviewRefusedError)) throw e;
    return e.code === "not_found" ? notFound() : error(e.code, 409);
  }
}

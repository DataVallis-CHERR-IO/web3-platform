import { NextResponse } from "next/server";
import type { z } from "zod";
import { requireRole } from "@/lib/auth/session";
import { verifyOrigin } from "@/lib/security/origin";
import { isUuid } from "@/lib/files/storage";
import { CampaignReviewRefusedError } from "./review";

/**
 * Every error the campaign review routes can return besides 404. The response
 * carries only the code; the text is the next-intl message `admin.campaigns.errors.<code>`.
 */
export const CAMPAIGN_REVIEW_ERROR_CODES = [
  "forbidden",
  "validation_failed",
  "not_pending",
  "self_review",
  "organization_not_approved",
  "rate_unavailable",
  "target_below_minimum",
  "not_approved",
  "not_prepared",
  "contracts_unavailable",
  "not_deployed",
  "chain_unavailable",
  "wrong_state",
] as const;
type CampaignReviewErrorCode = (typeof CAMPAIGN_REVIEW_ERROR_CODES)[number];

const error = (code: CampaignReviewErrorCode, status: number) => NextResponse.json({ error: code }, { status });

/**
 * Shared frame of the campaign review and publish handlers: PLATFORM_ADMIN
 * re-read from the DB (404 for everyone else), origin check, body validation,
 * and the mapping of refusals to responses. A missing ECB rate is 503 (retry later).
 */
export async function handleCampaignReview<T>(
  request: Request,
  params: Promise<{ id: string }>,
  bodySchema: z.ZodType<T>,
  action: (reviewerId: string, campaignId: string, body: T) => Promise<unknown>
) {
  const notFound = () => new NextResponse(null, { status: 404 });
  let reviewerId: string;
  try {
    reviewerId = (await requireRole("PLATFORM_ADMIN", request)).userId;
  } catch {
    return notFound();
  }
  if (!verifyOrigin(request)) return error("forbidden", 403);
  const { id } = await params;
  if (!isUuid(id)) return notFound();

  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return error("validation_failed", 400);

  try {
    return NextResponse.json(await action(reviewerId, id, body.data));
  } catch (e) {
    if (!(e instanceof CampaignReviewRefusedError)) throw e;
    if (e.code === "not_found") return notFound();
    return error(e.code, e.code === "rate_unavailable" || e.code === "chain_unavailable" ? 503 : 409);
  }
}

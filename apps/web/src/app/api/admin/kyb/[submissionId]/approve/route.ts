import { z } from "zod";
import { getDb } from "@/lib/db";
import { getClientIp } from "@/lib/security/rate-limit";
import { approveSubmission } from "@/lib/organizations/review";
import { handleReview } from "@/lib/organizations/review-route";

export const dynamic = "force-dynamic";

/** The last six characters of the payout address, typed by the reviewer to confirm it. */
const bodySchema = z.object({ payoutAddressTail: z.string().trim().length(6) });

/** POST /api/admin/kyb/:submissionId/approve — PLATFORM_ADMIN only. */
export function POST(request: Request, { params }: { params: Promise<{ submissionId: string }> }) {
  return handleReview(request, params, bodySchema, (reviewerId, submissionId, body) =>
    approveSubmission(getDb(), reviewerId, submissionId, body.payoutAddressTail, getClientIp(request))
  );
}

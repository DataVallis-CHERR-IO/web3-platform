import { z } from "zod";
import { getDb } from "@/lib/db";
import { getClientIp } from "@/lib/security/rate-limit";
import { rejectSubmission } from "@/lib/organizations/review";
import { handleReview } from "@/lib/organizations/review-route";

export const dynamic = "force-dynamic";

/** The note is shown to the applicant. */
const bodySchema = z.object({ note: z.string().trim().min(10).max(1000) });

/** POST /api/admin/kyb/:submissionId/reject — PLATFORM_ADMIN only. */
export function POST(request: Request, { params }: { params: Promise<{ submissionId: string }> }) {
  return handleReview(request, params, bodySchema, (reviewerId, submissionId, body) =>
    rejectSubmission(getDb(), reviewerId, submissionId, body.note, getClientIp(request))
  );
}

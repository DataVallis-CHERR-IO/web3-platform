import { z } from "zod";
import { getDb } from "@/lib/db";
import { getClientIp } from "@/lib/security/rate-limit";
import { NOTE_MAX, NOTE_MIN, recordChainIntent } from "@/lib/admin/guardian";
import { handleCampaignReview } from "@/lib/campaigns/review-route";

export const dynamic = "force-dynamic";

const note = z.string().trim().min(NOTE_MIN).max(NOTE_MAX);

const optionalNote = z.union([note, z.literal("")]).default("");

/** Guardian decisions need a note; the payout mode and the fallbacks (TASK-033f) may have one. */
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("setPayoutMode"), mode: z.union([z.literal(0), z.literal(1)]), note: optionalNote }),
  z.object({ action: z.literal("resolve"), approve: z.boolean(), note }),
  z.object({ action: z.literal("freeze"), note }),
  z.object({ action: z.literal("finalize"), note: optionalNote }),
  z.object({ action: z.literal("closeVote"), note: optionalNote }),
  z.object({ action: z.literal("sweepUnclaimed"), note: optionalNote }),
]);

/**
 * POST /api/admin/campaigns/:id/chain-actions — PLATFORM_ADMIN only (TASK-033d, fallbacks TASK-033f).
 * Before the admin's wallet opens: checks the action against the indexed state
 * and writes the note to audit_log. Returns `{ requestId }` for the `sent` call.
 */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleCampaignReview(request, params, bodySchema, (adminId, campaignId, body) =>
    recordChainIntent(getDb(), adminId, campaignId, body, getClientIp(request))
  );
}

import { z } from "zod";
import { getDb } from "@/lib/db";
import { getClientIp } from "@/lib/security/rate-limit";
import { RESOLVE_NOTE_MAX, RESOLVE_NOTE_MIN, recordResolveIntent } from "@/lib/pool/resolve";
import { handleAllocationResolve } from "@/lib/pool/resolve-route";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ approve: z.boolean(), note: z.string().trim().min(RESOLVE_NOTE_MIN).max(RESOLVE_NOTE_MAX) });

/**
 * POST /api/admin/emergency-pool/allocations/:id/resolve — PLATFORM_ADMIN only
 * (404 for everyone else; TASK-014c-3). Before the Guardian's wallet opens:
 * checks that the allocation is NEEDS_REVIEW and writes the decision and the
 * note to audit_log. Returns `{ requestId }` for the `sent` call.
 */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleAllocationResolve(request, params, bodySchema, (adminId, allocationId, body) =>
    recordResolveIntent(getDb(), adminId, allocationId, body, getClientIp(request))
  );
}

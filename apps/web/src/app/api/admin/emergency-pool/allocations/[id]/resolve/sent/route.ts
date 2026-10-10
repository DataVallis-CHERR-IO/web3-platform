import { z } from "zod";
import { getDb } from "@/lib/db";
import { getClientIp } from "@/lib/security/rate-limit";
import { recordResolveSent } from "@/lib/pool/resolve";
import { handleAllocationResolve } from "@/lib/pool/resolve-route";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  requestId: z.string().uuid(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

/** POST /api/admin/emergency-pool/allocations/:id/resolve/sent — PLATFORM_ADMIN only: links the transaction to the request. */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleAllocationResolve(request, params, bodySchema, (adminId, allocationId, body) =>
    recordResolveSent(getDb(), adminId, allocationId, body, getClientIp(request))
  );
}

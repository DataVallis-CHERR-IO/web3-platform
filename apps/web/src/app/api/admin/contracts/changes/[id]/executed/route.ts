import { z } from "zod";
import { getDb } from "@/lib/db";
import { getClientIp } from "@/lib/security/rate-limit";
import { isUuid } from "@/lib/files/storage";
import { ContractChangeError, recordClosed } from "@/lib/contracts/changes";
import { handleContractsRoute } from "@/lib/contracts/route";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict();

/** POST /api/admin/contracts/changes/:id/executed — PLATFORM_ADMIN only; records the admin's executeBatch transaction. */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleContractsRoute(request, true, async (adminId) => {
    const { id } = await params;
    if (!isUuid(id)) throw new ContractChangeError("not_found");
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) throw new ContractChangeError("validation_failed");
    return recordClosed(getDb(), adminId, id, "executed", body.data.txHash, getClientIp(request));
  });
}

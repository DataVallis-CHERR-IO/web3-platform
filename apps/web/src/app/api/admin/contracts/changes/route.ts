import { z } from "zod";
import { getDb } from "@/lib/db";
import { getClientIp } from "@/lib/security/rate-limit";
import { ContractChangeError, consoleContracts, listChanges, recordScheduled } from "@/lib/contracts/changes";
import { handleContractsRoute } from "@/lib/contracts/route";

export const dynamic = "force-dynamic";

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/).max(1024);
const bodySchema = z
  .object({
    chainId: z.number().int().positive(),
    timelock: hex,
    operationId: hex,
    targets: z.array(hex).min(1).max(10),
    payloads: z.array(hex).min(1).max(10),
    predecessor: hex,
    salt: hex,
    delaySeconds: z.number().int().min(0).max(60 * 60 * 24 * 30),
    previous: z.record(z.string(), z.string().max(100)).default({}),
    txHash: hex,
  })
  .strict();

/** GET /api/admin/contracts/changes — PLATFORM_ADMIN only; recorded config changes, newest first. */
export function GET(request: Request) {
  return handleContractsRoute(request, false, async () => ({ changes: await listChanges(getDb()) }));
}

/** POST /api/admin/contracts/changes — records a scheduleBatch the admin has just signed (TASK-034a). */
export function POST(request: Request) {
  return handleContractsRoute(request, true, async (adminId) => {
    const contracts = consoleContracts();
    if (!contracts) throw new ContractChangeError("not_configured");
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) throw new ContractChangeError("validation_failed");
    return recordScheduled(getDb(), adminId, body.data, contracts, getClientIp(request));
  });
}

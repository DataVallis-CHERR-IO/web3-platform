import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { verifyOrigin } from "@/lib/security/origin";
import { getClientIp } from "@/lib/security/rate-limit";
import { REASON_MAX, saveAllocationReason } from "@/lib/pool/allocations";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  poolId: z.number().int().min(0).max(4_294_967_295),
  campaignId: z.string().uuid(),
  /** USDC base units as a decimal string (bigint). */
  amountUsdc: z.string().regex(/^[1-9]\d{0,30}$/),
  reason: z.string().min(1).max(REASON_MAX * 2),
});

/**
 * POST /api/admin/emergency-pool/allocations/reason — PLATFORM_ADMIN only (404
 * for everyone else; TASK-014c): stores the public reason of an allocation the
 * Operator is about to propose and returns its reasonHash.
 */
export async function POST(request: Request) {
  let adminId: string;
  try {
    adminId = (await requireRole("PLATFORM_ADMIN", request)).userId;
  } catch {
    return new NextResponse(null, { status: 404 });
  }
  if (!verifyOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "validation_failed" }, { status: 400 });
  const result = await saveAllocationReason(
    getDb(), adminId,
    { poolId: body.data.poolId, campaignId: body.data.campaignId, amountUsdc: BigInt(body.data.amountUsdc), text: body.data.reason },
    getClientIp(request)
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ reasonHash: result.reasonHash, campaign: result.campaignAddress });
}

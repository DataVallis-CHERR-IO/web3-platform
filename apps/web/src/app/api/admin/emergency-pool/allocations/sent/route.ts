import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { verifyOrigin } from "@/lib/security/origin";
import { getClientIp } from "@/lib/security/rate-limit";
import { recordAllocationSent } from "@/lib/pool/allocations";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  reasonHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

/**
 * POST /api/admin/emergency-pool/allocations/sent — PLATFORM_ADMIN only (404 for
 * everyone else; TASK-014c): records the proposeAllocation transaction an admin's
 * wallet sent. 404 for a reason that was never saved.
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
  const recorded = await recordAllocationSent(getDb(), adminId, body.data, getClientIp(request));
  return recorded ? NextResponse.json({ ok: true }) : new NextResponse(null, { status: 404 });
}

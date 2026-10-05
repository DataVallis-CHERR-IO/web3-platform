import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { verifyOrigin } from "@/lib/security/origin";
import { getClientIp } from "@/lib/security/rate-limit";
import { recordSubpoolSent } from "@/lib/admin/subpools";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  poolId: z.number().int().min(1).max(4_294_967_295),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

/**
 * POST /api/admin/emergency-pool/subpools/sent — PLATFORM_ADMIN only (404 for
 * everyone else): records the `createSubPool` transaction an admin's wallet sent
 * (TASK-046). 404 for a pool id that is not a seeded theme.
 */
export async function POST(request: Request) {
  const notFound = () => new NextResponse(null, { status: 404 });
  let adminId: string;
  try {
    adminId = (await requireRole("PLATFORM_ADMIN", request)).userId;
  } catch {
    return notFound();
  }
  if (!verifyOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "validation_failed" }, { status: 400 });
  const recorded = await recordSubpoolSent(getDb(), adminId, body.data, getClientIp(request));
  return recorded ? NextResponse.json({ ok: true }) : notFound();
}

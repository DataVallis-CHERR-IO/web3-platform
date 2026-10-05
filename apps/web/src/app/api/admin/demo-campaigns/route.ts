import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/session";
import { verifyOrigin } from "@/lib/security/origin";
import { getClientIp } from "@/lib/security/rate-limit";
import { getDb } from "@/lib/db";
import { createDemoCampaigns, demoCampaignsAllowed, demoRequestSchema, DemoRefusedError } from "@/lib/demo/create";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/demo-campaigns — PLATFORM_ADMIN only (404 for everyone else),
 * and only where APP_ENV is local or dev (ADR-052; 404 on uat/prod, like a route
 * that does not exist). Body: { count 1–10, payoutAddress, durationMode }.
 */
export async function POST(request: Request) {
  const notFound = () => new NextResponse(null, { status: 404 });
  if (!demoCampaignsAllowed()) return notFound();
  let adminId: string;
  try {
    adminId = (await requireRole("PLATFORM_ADMIN", request)).userId;
  } catch {
    return notFound();
  }
  if (!verifyOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = demoRequestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "validation_failed" }, { status: 400 });
  try {
    const result = await createDemoCampaigns(getDb(), adminId, body.data, { ip: getClientIp(request) });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (!(e instanceof DemoRefusedError)) throw e;
    if (e.code === "not_allowed") return notFound();
    return NextResponse.json({ error: e.code }, { status: 503 });
  }
}

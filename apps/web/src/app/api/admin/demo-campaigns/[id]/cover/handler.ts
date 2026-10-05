import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/session";
import { verifyOrigin } from "@/lib/security/origin";
import { isUuid } from "@/lib/files/storage";
import { demoCampaignsAllowed } from "@/lib/demo/create";
import { DemoCoverError, type DemoCoverResult } from "@/lib/demo/cover";

/**
 * Shared frame of the demo cover routes (TASK-038b): 404 outside local/dev, for
 * non-admins and for unknown or non-demo campaigns; origin check; 503 when
 * FAL_KEY is missing or fal fails (the admin may try again).
 */
export async function handleDemoCover(
  request: Request,
  params: Promise<{ id: string }>,
  action: (adminId: string, campaignId: string, body: unknown) => Promise<DemoCoverResult>
) {
  const notFound = () => new NextResponse(null, { status: 404 });
  if (!demoCampaignsAllowed()) return notFound();
  let adminId: string;
  try {
    adminId = (await requireRole("PLATFORM_ADMIN", request)).userId;
  } catch {
    return notFound();
  }
  if (!verifyOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  if (!isUuid(id)) return notFound();
  const body = await request.json().catch(() => null);
  try {
    const result = await action(adminId, id, body);
    return NextResponse.json(result, { status: result.status === "done" ? 201 : 202 });
  } catch (e) {
    if (!(e instanceof DemoCoverError)) throw e;
    if (e.code === "not_found" || e.code === "not_allowed") return notFound();
    if (e.code === "bad_request") return NextResponse.json({ error: e.code }, { status: 400 });
    return NextResponse.json({ error: e.code }, { status: 503 });
  }
}

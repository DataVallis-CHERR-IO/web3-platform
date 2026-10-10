import { NextResponse } from "next/server";
import type { z } from "zod";
import { requireRole } from "@/lib/auth/session";
import { verifyOrigin } from "@/lib/security/origin";
import { AllocationResolveRefusedError } from "./resolve";

/**
 * Shared frame of the allocation resolve routes (TASK-014c-3): PLATFORM_ADMIN
 * with the second factor, re-read from the DB (404 for everyone else), origin
 * check, a numeric allocation id, body validation, refusals → 404 / 409 / 503.
 */
export async function handleAllocationResolve<T>(
  request: Request,
  params: Promise<{ id: string }>,
  bodySchema: z.ZodType<T>,
  action: (adminId: string, allocationId: bigint, body: T) => Promise<unknown>
) {
  const notFound = () => new NextResponse(null, { status: 404 });
  let adminId: string;
  try {
    adminId = (await requireRole("PLATFORM_ADMIN", request)).userId;
  } catch {
    return notFound();
  }
  if (!verifyOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  if (!/^\d{1,30}$/.test(id)) return notFound();
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "validation_failed" }, { status: 400 });
  try {
    return NextResponse.json((await action(adminId, BigInt(id), body.data)) ?? { ok: true });
  } catch (e) {
    if (!(e instanceof AllocationResolveRefusedError)) throw e;
    if (e.code === "not_found") return notFound();
    return NextResponse.json({ error: e.code }, { status: e.code === "chain_unavailable" ? 503 : 409 });
  }
}

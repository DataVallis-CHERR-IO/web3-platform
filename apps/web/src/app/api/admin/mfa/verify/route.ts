import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { verifyFactor } from "@/lib/auth/admin-mfa";
import { codeBodySchema, handleMfa, withMfaCookie } from "@/lib/auth/mfa-route";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/mfa/verify `{ code }` — PLATFORM_ADMIN only (ADR-056). A code
 * from the app or a recovery code (single use); sets the MFA cookie for 12 hours.
 */
export function POST(request: Request) {
  return handleMfa(request, async ({ userId, ip, body }) => {
    const parsed = codeBodySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "invalid_code" }, { status: 400 });
    const { id, method, recoveryCodesLeft } = await verifyFactor(getDb(), userId, parsed.data.code, { ip });
    return withMfaCookie(userId, id, { method, recoveryCodesLeft });
  });
}

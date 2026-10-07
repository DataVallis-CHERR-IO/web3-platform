import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { confirmEnrolment } from "@/lib/auth/admin-mfa";
import { codeBodySchema, handleMfa, withMfaCookie } from "@/lib/auth/mfa-route";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/mfa/confirm `{ code }` — PLATFORM_ADMIN only (ADR-056). The
 * first code from the app confirms the enrolment; answers the recovery codes
 * (shown once) and sets the MFA cookie.
 */
export function POST(request: Request) {
  return handleMfa(request, async ({ userId, ip, body }) => {
    const parsed = codeBodySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "invalid_code" }, { status: 400 });
    const { id, recoveryCodes } = await confirmEnrolment(getDb(), userId, parsed.data.code, { ip });
    return withMfaCookie(userId, id, { recoveryCodes });
  });
}

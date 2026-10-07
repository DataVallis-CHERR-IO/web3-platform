import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePlatformAdminRole } from "@/lib/auth/session";
import { verifyOrigin } from "@/lib/security/origin";
import { getClientIp, MFA_RATE_LIMIT, mfaRateLimiter } from "@/lib/security/rate-limit";
import { MfaError, mfaCookieOptions, signMfaCookie } from "./admin-mfa";

// Shared frame of /api/admin/mfa/* (ADR-056): PLATFORM_ADMIN role re-read from
// the DB (404 for everyone else), origin check, 10 attempts per 15 minutes per
// user, refusals → `{ error: <code> }`. The text of a code is the next-intl
// message `admin.mfa.errors.<code>`.

const STATUS: Record<MfaError["code"], number> = {
  already_enrolled: 409,
  not_enrolled: 409,
  no_pending_enrolment: 409,
  invalid_code: 400,
};

export const codeBodySchema = z.object({ code: z.string().trim().min(6).max(20) });

export async function handleMfa(
  request: Request,
  action: (ctx: { userId: string; ip: string; body: unknown }) => Promise<NextResponse>
): Promise<NextResponse> {
  let userId: string;
  try {
    userId = (await requirePlatformAdminRole(request)).userId;
  } catch {
    return new NextResponse(null, { status: 404 });
  }
  if (!verifyOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const limit = mfaRateLimiter.check(`mfa:${userId}`, MFA_RATE_LIMIT);
  if (!limit.success) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(limit.reset) } });
  }

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  try {
    return await action({ userId, ip: getClientIp(request), body });
  } catch (e) {
    if (e instanceof MfaError) return NextResponse.json({ error: e.code }, { status: STATUS[e.code] });
    throw e;
  }
}

/** A JSON answer that also sets the `cherrio_admin_mfa` cookie. */
export async function withMfaCookie(userId: string, enrolmentId: string, payload: object): Promise<NextResponse> {
  const response = NextResponse.json(payload);
  response.cookies.set({ ...mfaCookieOptions(), value: await signMfaCookie(userId, enrolmentId) });
  return response;
}

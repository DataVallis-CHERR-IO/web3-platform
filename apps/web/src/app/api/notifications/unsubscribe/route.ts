import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { PREFERENCES_RATE_LIMIT, getClientIp, preferencesRateLimiter } from "@/lib/security/rate-limit";
import { unsubscribeByToken } from "@/lib/notifications/preferences";

export const dynamic = "force-dynamic";

/**
 * POST /api/notifications/unsubscribe?token=… — RFC 8058 one-click unsubscribe
 * (mail clients POST here from the List-Unsubscribe header) and the button on
 * /en/notifications/unsubscribe. No origin check: the token is the credential,
 * and a mail client's request has no CHERR.IO origin. GET never unsubscribes
 * (link scanners follow GET links).
 */
export async function POST(request: Request) {
  const limit = preferencesRateLimiter.check(getClientIp(request), PREFERENCES_RATE_LIMIT);
  if (!limit.success) return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const ok = await unsubscribeByToken(getDb(), token);
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "unknown_token" }, { status: 404 });
}

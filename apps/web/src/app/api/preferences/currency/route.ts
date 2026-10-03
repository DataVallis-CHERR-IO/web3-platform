import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { users } from "@cherrio/db";
import { isDisplayCurrency } from "@cherrio/shared";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { displayCurrencyCookie } from "@/lib/fx/cookie";
import { verifyOrigin } from "@/lib/security/origin";
import { PREFERENCES_RATE_LIMIT, getClientIp, preferencesRateLimiter } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Sets the display currency (ADR-040): a cookie for everyone, and the profile
 * of a logged-in user so it follows them to other devices. Display only.
 */
export async function PUT(request: Request) {
  const limit = preferencesRateLimiter.check(getClientIp(request), PREFERENCES_RATE_LIMIT);
  if (!limit.success) {
    return NextResponse.json({ error: "too_many_requests" }, { status: 429, headers: { "Retry-After": String(limit.reset) } });
  }
  if (!verifyOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: { currency?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!isDisplayCurrency(body.currency)) return NextResponse.json({ error: "currency_not_supported" }, { status: 400 });
  const currency = body.currency;

  const session = await getSession(request);
  if (session) {
    await getDb().update(users).set({ displayCurrency: currency }).where(eq(users.id, session.userId));
  }

  const response = NextResponse.json({ currency });
  response.cookies.set(displayCurrencyCookie(currency));
  return response;
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { verifyOrigin } from "@/lib/security/origin";
import { PREFERENCES_RATE_LIMIT, getClientIp, preferencesRateLimiter } from "@/lib/security/rate-limit";
import {
  NotificationPreferenceError, getNotificationSettings, removeContactEmail, requestContactEmail,
} from "@/lib/notifications/preferences";

export const dynamic = "force-dynamic";

async function guard(request: Request): Promise<{ error: NextResponse } | { userId: string }> {
  const limit = preferencesRateLimiter.check(getClientIp(request), PREFERENCES_RATE_LIMIT);
  if (!limit.success) return { error: NextResponse.json({ error: "too_many_requests" }, { status: 429 }) };
  if (!verifyOrigin(request)) return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  const session = await getSession(request);
  if (!session) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  return { userId: session.userId };
}

const bodySchema = z.object({ email: z.string().max(320) });

/**
 * POST /api/me/notifications/email — `{ email }`: starts the double opt-in for a
 * contact address (wallet-only users, ADR-048). The worker sends the link.
 * 400 email_invalid, 409 same_as_login, 429 too_many_requests (3 per hour).
 */
export async function POST(request: Request) {
  const g = await guard(request);
  if ("error" in g) return g.error;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "email_invalid" }, { status: 400 });
  const db = getDb();
  try {
    await requestContactEmail(db, g.userId, body.data.email, new Date(), getClientIp(request));
  } catch (e) {
    if (!(e instanceof NotificationPreferenceError)) throw e;
    const status = e.code === "email_invalid" ? 400 : e.code === "too_many_requests" ? 429 : 409;
    return NextResponse.json({ error: e.code }, { status });
  }
  return NextResponse.json(await getNotificationSettings(db, g.userId));
}

/** DELETE /api/me/notifications/email — removes the contact address (and a pending one). */
export async function DELETE(request: Request) {
  const g = await guard(request);
  if ("error" in g) return g.error;
  const db = getDb();
  await removeContactEmail(db, g.userId, getClientIp(request));
  return NextResponse.json(await getNotificationSettings(db, g.userId));
}

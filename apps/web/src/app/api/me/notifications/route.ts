import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { verifyOrigin } from "@/lib/security/origin";
import { PREFERENCES_RATE_LIMIT, getClientIp, preferencesRateLimiter } from "@/lib/security/rate-limit";
import { getNotificationSettings, setEmailEnabled } from "@/lib/notifications/preferences";

export const dynamic = "force-dynamic";

/** GET /api/me/notifications — the caller's email notification settings (TASK-033e). */
export async function GET(request: Request) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await getNotificationSettings(getDb(), session.userId), { headers: { "Cache-Control": "no-store" } });
}

const bodySchema = z.object({ emailEnabled: z.boolean() });

/** PUT /api/me/notifications — `{ emailEnabled }`: on/off for every lifecycle email. */
export async function PUT(request: Request) {
  const limit = preferencesRateLimiter.check(getClientIp(request), PREFERENCES_RATE_LIMIT);
  if (!limit.success) return NextResponse.json({ error: "too_many_requests" }, { status: 429, headers: { "Retry-After": String(limit.reset) } });
  if (!verifyOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "validation_failed" }, { status: 400 });
  const db = getDb();
  await setEmailEnabled(db, session.userId, body.data.emailEnabled, getClientIp(request));
  return NextResponse.json(await getNotificationSettings(db, session.userId));
}

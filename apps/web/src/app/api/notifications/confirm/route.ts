import { NextResponse } from "next/server";
import { parseAppEnv } from "@cherrio/shared";
import { getDb } from "@/lib/db";
import { getExpectedOrigin } from "@/lib/security/origin";
import { confirmContactEmail } from "@/lib/notifications/preferences";

export const dynamic = "force-dynamic";

/**
 * The public origin for the redirect. Behind kamal-proxy `request.url` is the
 * container's own address (http://0.0.0.0:3000 — bug found on dev 2026-10-04),
 * so deployed environments use their fixed origin; only `local` keeps the
 * request's origin (tests and `next start` on any port).
 */
function publicOrigin(request: Request): string {
  let appEnv: ReturnType<typeof parseAppEnv> = "local";
  try {
    appEnv = parseAppEnv(process.env.APP_ENV ?? "local");
  } catch {
    appEnv = "local";
  }
  return appEnv === "local" ? new URL(request.url).origin : getExpectedOrigin(appEnv);
}

/**
 * GET /api/notifications/confirm?token=… — the link in the confirmation email
 * (TASK-033e). Redirects to the result page; the confirmation itself needs no login.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const ok = await confirmContactEmail(getDb(), token);
  return NextResponse.redirect(new URL(`/en/notifications/confirmed?ok=${ok ? 1 : 0}`, publicOrigin(request)), 303);
}

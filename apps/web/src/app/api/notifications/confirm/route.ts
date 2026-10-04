import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { confirmContactEmail } from "@/lib/notifications/preferences";

export const dynamic = "force-dynamic";

/**
 * GET /api/notifications/confirm?token=… — the link in the confirmation email
 * (TASK-033e). Redirects to the settings page with the result; the page needs a
 * login to show the settings, the confirmation itself does not.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const ok = await confirmContactEmail(getDb(), url.searchParams.get("token") ?? "");
  return NextResponse.redirect(new URL(`/en/notifications/confirmed?ok=${ok ? 1 : 0}`, url.origin), 303);
}

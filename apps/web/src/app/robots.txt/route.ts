/**
 * GET /robots.txt
 * prod: every crawler — search engines and AI crawlers — may read the public
 * pages (David, 2026-10-04, TASK-035). The admin area is deliberately NOT
 * listed here (that would advertise it); it answers 404 to non-admins and
 * sends `X-Robots-Tag: noindex` itself (middleware).
 * Other environments: every crawler is blocked, AI crawlers also by name for
 * those that only read their own group.
 */
import { NextResponse } from "next/server";
import { parseAppEnv } from "@cherrio/shared";
import { getExpectedOrigin } from "@/lib/security/origin";
import { robotsBody } from "@/lib/security/robots";

export const dynamic = "force-dynamic";

export function GET() {
  const origin = getExpectedOrigin(parseAppEnv(process.env.APP_ENV ?? "local"));
  return new NextResponse(robotsBody(process.env.APP_ENV, origin), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

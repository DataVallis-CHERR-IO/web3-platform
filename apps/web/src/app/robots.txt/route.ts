/**
 * GET /robots.txt
 * Blocks all crawlers on non-prod environments.
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  const isProd = process.env.APP_ENV === "prod";

  const body = isProd
    ? `User-agent: *\nAllow: /\n`
    : `User-agent: *\nDisallow: /\n`;

  return new NextResponse(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

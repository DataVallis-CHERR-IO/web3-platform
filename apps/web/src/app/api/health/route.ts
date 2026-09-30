/**
 * GET /api/health
 * Kamal-proxy healthcheck endpoint. Returns 200 with status payload.
 * Not behind next-intl middleware (no locale prefix).
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    status: "ok",
    env: process.env.APP_ENV ?? "unknown",
    sha: process.env.NEXT_PUBLIC_GIT_SHA ?? "unknown",
    timestamp: new Date().toISOString(),
  });
}

/**
 * GET /api/health
 * Kamal-proxy healthcheck endpoint. Returns 200 with status payload.
 * Not behind next-intl middleware (no locale prefix).
 */
import { NextResponse } from "next/server";
import { validateAuthEnv } from "@cherrio/shared";

export const dynamic = "force-dynamic";

export function GET() {
  try {
    validateAuthEnv();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Auth configuration error";
    console.error("[Health] Auth configuration error:", message);
    return NextResponse.json(
      {
        status: "error",
        error: "auth_config_error",
        env: process.env.APP_ENV ?? "unknown",
        sha: process.env.NEXT_PUBLIC_GIT_SHA ?? "unknown",
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    status: "ok",
    env: process.env.APP_ENV ?? "unknown",
    sha: process.env.NEXT_PUBLIC_GIT_SHA ?? "unknown",
    timestamp: new Date().toISOString(),
  });
}

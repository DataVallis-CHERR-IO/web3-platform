/**
 * GET /api/health
 * Kamal-proxy healthcheck endpoint. Checks the auth environment and the
 * database path the app really uses (DATABASE_URL = PgBouncer).
 * Not behind next-intl middleware (no locale prefix).
 */
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { validateAuthEnv } from "@cherrio/shared";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Must stay below the kamal-proxy healthcheck timeout (config/deploy.yml: 3 s). */
const DB_CHECK_TIMEOUT_MS = 2_000;

function meta() {
  return {
    env: process.env.APP_ENV ?? "unknown",
    sha: process.env.NEXT_PUBLIC_GIT_SHA ?? "unknown",
    timestamp: new Date().toISOString(),
  };
}

function errorResponse(error: string, status: number) {
  return NextResponse.json({ status: "error", error, ...meta() }, { status });
}

/**
 * Runs `select 1` through getDb() and rejects after DB_CHECK_TIMEOUT_MS.
 *
 * Known limitation: a timed-out query is not cancelled. It stays queued in the
 * postgres.js pool until the driver's own connect timeout (30 s) rejects it.
 */
async function checkDb(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${DB_CHECK_TIMEOUT_MS} ms`)),
      DB_CHECK_TIMEOUT_MS
    );
  });
  try {
    await Promise.race([getDb().execute(sql`select 1`), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function GET() {
  let appEnv: string;
  try {
    appEnv = validateAuthEnv().appEnv;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Auth configuration error";
    console.error("[Health] Auth configuration error:", message);
    return errorResponse("auth_config_error", 500);
  }

  // Checked here because getDb() falls back to DATABASE_URL_DIRECT, which would
  // let the check pass over the direct path while PgBouncer is broken.
  if (!process.env.DATABASE_URL) {
    if (appEnv === "local") {
      return NextResponse.json({ status: "ok", db: "skipped", ...meta() });
    }
    console.error("[Health] DATABASE_URL is not set");
    return errorResponse("db_config_error", 503);
  }

  try {
    await checkDb();
  } catch (err: unknown) {
    // Only code + message: never the error object or the connection string.
    const code = (err as { code?: unknown } | null)?.code;
    const message = err instanceof Error ? err.message : "unknown error";
    console.error(
      "[Health] DB check failed:",
      typeof code === "string" ? code : "no_code",
      message
    );
    return errorResponse("db_unreachable", 503);
  }

  return NextResponse.json({ status: "ok", db: "ok", ...meta() });
}

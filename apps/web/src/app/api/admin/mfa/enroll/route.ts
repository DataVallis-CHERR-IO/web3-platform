import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { startEnrolment } from "@/lib/auth/admin-mfa";
import { handleMfa } from "@/lib/auth/mfa-route";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/mfa/enroll — PLATFORM_ADMIN only (ADR-056). Starts an
 * enrolment: QR code + key in text. 409 `already_enrolled` once a factor is confirmed.
 */
export function POST(request: Request) {
  return handleMfa(request, async ({ userId }) => NextResponse.json(await startEnrolment(getDb(), userId)));
}

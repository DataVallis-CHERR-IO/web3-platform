import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { getOrCreateRefCode } from "@/lib/referrals";

// GET /api/me/referral-code (TASK-055, ADR-057 §5): the signed-in user's
// personal share code, created on first use. 401 without a session — the share
// box then offers the plain campaign link.

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const code = await getOrCreateRefCode(getDb(), session.userId);
  return NextResponse.json({ code }, { headers: { "Cache-Control": "no-store" } });
}

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { lifecycleJson, loadLifecycle, loadUserPositions, nowSeconds, positionJson } from "@/lib/campaigns/lifecycle";

// GET /api/lifecycle/:campaign (TASK-033b): a campaign contract's state after it
// went live — vote round, turnout vs. its own quorum, due actions — from the
// indexer's views. Public; a logged-in user also gets the positions of their
// linked addresses with their next action. Used to refresh the lifecycle panel
// after a transaction.

export const dynamic = "force-dynamic";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function GET(request: Request, { params }: { params: Promise<{ campaign: string }> }) {
  const { campaign } = await params;
  if (!ADDRESS.test(campaign)) return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  const db = getDb();
  const lc = await loadLifecycle(db, campaign);
  if (!lc) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const now = nowSeconds();
  const session = await getSession(request);
  const positions = session ? await loadUserPositions(db, session.userId, lc) : null;
  return NextResponse.json(
    { now: now.toString(), lifecycle: lifecycleJson(lc, now), positions: positions?.map((p) => positionJson(lc, p, now)) ?? null },
    { headers: { "Cache-Control": "no-store" } }
  );
}

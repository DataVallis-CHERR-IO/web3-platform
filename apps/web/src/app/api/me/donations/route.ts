import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { lifecycleJson, listMyCampaignDonations, nowSeconds, positionJson, votesWaiting } from "@/lib/campaigns/lifecycle";

// GET /api/me/donations (TASK-033b): "My donations" — every campaign the
// logged-in user's linked addresses donated to, with its lifecycle and each
// address's next action (vote, refund, pool), plus the "votes waiting" count.

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const list = await listMyCampaignDonations(getDb(), session.userId);
  if (list === null) return NextResponse.json({ error: "chain_unavailable" }, { status: 503 });
  const now = nowSeconds();
  return NextResponse.json(
    {
      now: now.toString(),
      votesWaiting: votesWaiting(list, now),
      donations: list.map((d) => ({
        campaignId: d.campaignId,
        slug: d.slug,
        title: d.title,
        lifecycle: lifecycleJson(d.lifecycle, now),
        positions: d.positions.map((p) => positionJson(d.lifecycle, p, now)),
      })),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

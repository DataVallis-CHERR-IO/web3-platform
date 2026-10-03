import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { listMyDonations } from "@/lib/campaigns/public";

// "Your donation" box (TASK-011b): what the logged-in user gave to one campaign
// contract, per linked address, with the current failure preference. Read from
// the indexer's `chain.campaign_donor` view; amounts as decimal strings (bigint).

export const dynamic = "force-dynamic";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function GET(request: Request, { params }: { params: Promise<{ campaign: string }> }) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { campaign } = await params;
  if (!ADDRESS.test(campaign)) return NextResponse.json({ error: "invalid_address" }, { status: 400 });

  const rows = await listMyDonations(getDb(), session.userId, campaign);
  if (rows === null) return NextResponse.json({ error: "chain_unavailable" }, { status: 503 });
  return NextResponse.json(
    {
      donations: rows.map((r) => ({
        address: r.address,
        donated: r.donated.toString(),
        preference: r.preference === 1 ? "EMERGENCY_POOL" : "REFUND",
        subPoolId: r.subPoolId,
      })),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

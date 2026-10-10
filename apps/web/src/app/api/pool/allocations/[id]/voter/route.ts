import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { voterStatus } from "@/lib/pool/public";

export const dynamic = "force-dynamic";

/**
 * GET /api/pool/allocations/:id/voter?address=0x… — public (TASK-014c-2): the
 * weight an address may vote with in an Emergency Pool allocation and whether it
 * already voted, from the indexer's views. Everything here is public chain data.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const address = new URL(request.url).searchParams.get("address") ?? "";
  if (!/^\d{1,20}$/.test(id) || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "validation_failed" }, { status: 400 });
  }
  const status = await voterStatus(getDb(), BigInt(id), address);
  if (!status) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(
    { weight: status.weight.toString(), voted: status.voted },
    { headers: { "Cache-Control": "no-store" } }
  );
}

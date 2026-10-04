import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/files/storage";
import { publicManifest } from "@/lib/campaigns/evidence";

export const dynamic = "force-dynamic";

/**
 * GET /api/evidence/:bundleId/manifest — the exact manifest text of a bundle
 * that is on chain (TASK-033c, ADR-047). Its SHA-256 is the `bundleHash` of
 * the campaign's EvidenceSubmitted event, so anyone can check it. Drafts: 404.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ bundleId: string }> }) {
  const { bundleId } = await params;
  if (!isUuid(bundleId)) return new NextResponse(null, { status: 404 });
  const manifest = await publicManifest(getDb(), bundleId);
  if (manifest === null) return new NextResponse(null, { status: 404 });
  return new NextResponse(manifest, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `inline; filename="evidence-${bundleId.slice(-8)}.json"`,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

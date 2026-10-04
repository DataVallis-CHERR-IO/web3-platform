import { NextResponse } from "next/server";
import { getChainConfig, parseAppEnv } from "@cherrio/shared";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/files/storage";
import { campaignError } from "@/lib/campaigns/errors";
import { sealEvidence, unsealEvidence } from "@/lib/campaigns/evidence";
import { withMediaAccess } from "@/lib/campaigns/media-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/campaigns/:id/evidence/seal — freezes the open round's draft into
 * its manifest and returns `{ round, bundleHash, manifest }`; the beneficiary
 * wallet then signs `submitEvidence(bundleHash)` (ADR-047).
 */
export function POST(request: Request, { params }: Params) {
  return withMediaAccess(request, async (userId, ip) => {
    const { id } = await params;
    if (!isUuid(id)) return campaignError("not_found", 404);
    const chainId = getChainConfig(parseAppEnv(process.env.APP_ENV ?? "local")).chain.id;
    return NextResponse.json(await sealEvidence(getDb(), userId, id, chainId, ip));
  });
}

/** DELETE /api/campaigns/:id/evidence/seal — reopens the draft (only while nothing is on chain, 10 minutes after sealing). */
export function DELETE(request: Request, { params }: Params) {
  return withMediaAccess(request, async (userId, ip) => {
    const { id } = await params;
    if (!isUuid(id)) return campaignError("not_found", 404);
    await unsealEvidence(getDb(), userId, id, ip);
    return new NextResponse(null, { status: 204 });
  });
}

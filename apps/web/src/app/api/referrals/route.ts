import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { verifyOrigin } from "@/lib/security/origin";
import { REFERRAL_RATE_LIMIT, getClientIp, referralRateLimiter } from "@/lib/security/rate-limit";
import { recordCampaignReferral, refCodeFromRequest } from "@/lib/referrals";

// POST /api/referrals `{ campaign }` (TASK-055, ADR-057 §5): called by the
// donate box when a signed-in user starts a donation. Records who brought the
// user to this campaign from the first-touch `cherrio_ref` cookie (first
// touch per campaign wins). Always 200 with `{ recorded, reason? }` for a valid
// request — the donation must never wait for or fail because of this.

export const dynamic = "force-dynamic";

const bodySchema = z.object({ campaign: z.string().regex(/^0x[0-9a-fA-F]{40}$/) });

export async function POST(request: Request) {
  const limit = referralRateLimiter.check(getClientIp(request), REFERRAL_RATE_LIMIT);
  if (!limit.success) return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  if (!verifyOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const result = await recordCampaignReferral(getDb(), {
    userId: session.userId,
    campaignAddress: body.data.campaign,
    code: refCodeFromRequest(request),
  });
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}

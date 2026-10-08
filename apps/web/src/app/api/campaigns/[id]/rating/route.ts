import { NextResponse } from "next/server";
import { z } from "zod";
import { getChainConfig, parseAppEnv } from "@cherrio/shared";
import { RATING_COMMENT_MAX } from "@cherrio/shared/ratings";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/files/storage";
import { chainSignatureVerifier, loadRatingContext, saveRating } from "@/lib/ratings";
import { verifyOrigin } from "@/lib/security/origin";
import { RATING_RATE_LIMIT, getClientIp, ratingRateLimiter } from "@/lib/security/rate-limit";

// Ratings of organisations (ADR-058, TASK-057).
// GET  /api/campaigns/:id/rating — may the signed-in user rate, until when, their rating.
// POST /api/campaigns/:id/rating `{ stars, comment?, signer, issuedAt, signature }` —
//      a signed rating (EIP-712, @cherrio/shared/ratings) from a linked address.

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const ctx = await loadRatingContext(getDb(), id, session.userId);
  if (ctx.status === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(
    {
      status: ctx.status,
      organization: ctx.orgId,
      campaign: ctx.campaignAddress,
      windowEndsAt: ctx.windowEndsAt?.toISOString() ?? null,
      rating: ctx.rating && { ...ctx.rating, updatedAt: ctx.rating.updatedAt.toISOString() },
    },
    { headers: NO_STORE }
  );
}

const bodySchema = z.object({
  stars: z.number().int().min(1).max(5),
  comment: z.string().max(RATING_COMMENT_MAX * 2).nullable().optional(),
  signer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  issuedAt: z.number().int().positive(),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(20_000),
});

const STATUS: Record<string, number> = {
  invalid_request: 400, stale: 400, bad_signature: 400, not_your_address: 403, own: 403, not_donor: 403,
  individual: 409, not_finished: 409, window_closed: 409, not_found: 404,
};

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!verifyOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!ratingRateLimiter.check(session.userId, RATING_RATE_LIMIT).success) {
    return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const appEnv = parseAppEnv(process.env.APP_ENV ?? "local");
  const result = await saveRating(getDb(), {
    campaignId: id,
    userId: session.userId,
    rating: { ...body.data, signature: body.data.signature as `0x${string}` },
    chainId: getChainConfig(appEnv).chain.id,
    verifyContract: chainSignatureVerifier(),
    ip: getClientIp(request),
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: STATUS[result.error] ?? 400, headers: NO_STORE });
  return NextResponse.json({ saved: true, created: result.created }, { headers: NO_STORE });
}

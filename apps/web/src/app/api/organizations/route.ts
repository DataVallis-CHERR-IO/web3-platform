import { NextResponse } from "next/server";
import { organizationApplicationSchema } from "@cherrio/shared";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { verifyOrigin } from "@/lib/security/origin";
import { APPLICATION_RATE_LIMIT, applicationRateLimiter, getClientIp } from "@/lib/security/rate-limit";
import { ApplicationRefusedError, submitOrganizationApplication } from "@/lib/organizations/apply";
import { organizationError } from "@/lib/organizations/errors";

export const dynamic = "force-dynamic";

/**
 * POST /api/organizations — submit an organisation for verification (KYB, ADR-012):
 * a new organisation, a claim of an imported one, or a resubmission after a rejection.
 * The documents were uploaded before (POST /api/files/kyb); the body carries their ids.
 */
export async function POST(request: Request) {
  if (!verifyOrigin(request)) return organizationError("forbidden", 403);
  const session = await getSession(request);
  if (!session) return organizationError("unauthorized", 401);

  const limit = applicationRateLimiter.check(`org:${session.userId}`, APPLICATION_RATE_LIMIT);
  if (!limit.success) return organizationError("rate_limited", 429);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return organizationError("bad_request", 400);
  }
  const parsed = organizationApplicationSchema.safeParse(body);
  if (!parsed.success) {
    // Field names only — the form shows its own message per field.
    const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "")))];
    return organizationError("validation_failed", 400, { fields });
  }

  try {
    const result = await submitOrganizationApplication(getDb(), session.userId, parsed.data, getClientIp(request));
    return NextResponse.json(
      { organizationId: result.organizationId, submissionId: result.submissionId, claim: result.kind === "claim" },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof ApplicationRefusedError) return organizationError(error.code, 409);
    throw error;
  }
}

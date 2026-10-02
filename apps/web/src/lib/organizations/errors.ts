import { NextResponse } from "next/server";

/**
 * Every error POST /api/organizations can return. The response carries only the
 * code; the text for the user is the next-intl message `organizations.errors.<code>`.
 */
export const ORGANIZATION_ERROR_CODES = [
  "forbidden",
  "unauthorized",
  "rate_limited",
  "bad_request",
  "validation_failed",
  "application_pending",
  "organization_exists",
  "resubmission_not_allowed",
  "files_invalid",
] as const;

export type OrganizationErrorCode = (typeof ORGANIZATION_ERROR_CODES)[number];

export function organizationError(code: OrganizationErrorCode, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: code, ...extra }, { status });
}

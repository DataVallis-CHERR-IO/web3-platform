import { NextResponse } from "next/server";

/**
 * Every error the campaign draft routes can return. The response carries only
 * the code; the text is the next-intl message `campaigns.errors.<code>`.
 */
export const CAMPAIGN_ERROR_CODES = [
  "forbidden",
  "unauthorized",
  "rate_limited",
  "bad_request",
  "validation_failed",
  "not_found",
  "organization_not_approved",
  "not_editable",
  "cover_required",
  "too_many_active",
  "length_required",
  "busy",
  "file_empty",
  "file_too_large",
  "file_type_not_allowed",
] as const;
export type CampaignErrorCode = (typeof CAMPAIGN_ERROR_CODES)[number];

export function campaignError(code: CampaignErrorCode, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: code, ...extra }, { status });
}

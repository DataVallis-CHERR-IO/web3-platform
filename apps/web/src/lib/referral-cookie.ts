// Edge-safe part of the share links (ADR-057 §5, TASK-055): used by
// middleware.ts, so no Node imports here. The rest is in lib/referrals.ts.

export const REF_COOKIE = "cherrio_ref";
export const REF_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // seconds
/** What `?ref=` and the cookie may hold; matches the `users_ref_code_format` check (8–16). */
export const REF_CODE_PATTERN = /^[a-z0-9]{8,16}$/;

export function isRefCode(value: string | null | undefined): value is string {
  return typeof value === "string" && REF_CODE_PATTERN.test(value);
}

/**
 * The cookie to set for a page request, or null: only for a well-formed
 * `?ref=` and only when the visitor has no referral cookie yet (first touch).
 */
export function firstTouchRefCode(ref: string | null, existingCookie: string | undefined): string | null {
  if (existingCookie !== undefined && isRefCode(existingCookie)) return null;
  const code = ref?.trim().toLowerCase() ?? null;
  return isRefCode(code) ? code : null;
}

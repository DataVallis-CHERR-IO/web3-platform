# TASK-049 — Admin second factor (own TOTP)

Decision: ADR-056 (David, 2026-10-05). Replaces the "fresh Privy MFA" line of `02-ARCHITECTURE.md` §3 and closes the open item "admin MFA (TASK-021)".

## Goal
No admin page and no `/api/admin/*` route works for a `PLATFORM_ADMIN` who has not proved a second factor (an authenticator-app code) in the last 12 hours.

## Scope
Part a (PR 1) — storage, crypto and API, no enforcement yet:
1. Table `app.admin_mfa` (one row per user): encrypted TOTP secret, `confirmed_at`, `last_used_step`, `recovery_code_hashes`. Migration `0014`. `eraseUser()` deletes the row.
2. `apps/web/src/lib/auth/admin-mfa.ts`: RFC 6238 TOTP (SHA-1, 6 digits, 30 s, ±1 step), base32, AES-256-GCM secret encryption and the cookie signing key derived by HKDF from `SESSION_SECRET`, recovery codes (10, single use, SHA-256 hashes), the `cherrio_admin_mfa` cookie (JWT, 12 h, bound to user + enrolment id), enrol / confirm / verify with replay protection.
3. Routes (PLATFORM_ADMIN only, 404 otherwise; origin check; rate limit 10 / 15 min per user):
   - `POST /api/admin/mfa/enroll` → QR (SVG data URL), key in text; `409 already_enrolled` if a confirmed factor exists;
   - `POST /api/admin/mfa/confirm` `{ code }` → recovery codes once + cookie;
   - `POST /api/admin/mfa/verify` `{ code }` (6 digits or a recovery code) → cookie.
4. Audit `admin.mfa_enrolled`, `admin.mfa_verified`.

Part b (PR 2) — enforcement and UI:
1. `requireRole("PLATFORM_ADMIN")` also requires a valid MFA cookie; `requirePlatformAdminRole()` (role only) is used by the MFA routes and the admin layout.
2. Admin layout: role but no confirmed factor → enrolment screen; factor but no valid cookie → code screen; otherwise the page.
3. Logout clears the cookie.
4. `packages/db` CLI `reset-admin-mfa <address>` (bundled like `grant-admin`), audit `admin.mfa_reset`.
5. Test helpers (Vitest + E2E) give admin test users an enrolled factor and the cookie; E2E spec for enrol → recovery codes → admin page, and code screen after the cookie is gone.
6. Docs: `docs/technical/04`, `06`, `09`, `08` (reset), owner guide (enrolment + reset), CHEATSHEET.

## Must not
- add a new secret (key derived from `SESSION_SECRET`);
- allow re-enrolment while a confirmed factor exists;
- store recovery codes or the TOTP secret in clear.

## Tests
- TOTP against the RFC 6238 SHA-1 test vectors; drift ±1 accepted, ±2 refused; a used step refused.
- Encryption round trip; a tampered ciphertext fails.
- Routes: non-admin 404; re-enrol refused; wrong code 400; replay 400; recovery code works once; rate limit 429; cookie of another user / old enrolment refused.
- Deliberate breaks recorded in `TASK-049.feedback.md`.

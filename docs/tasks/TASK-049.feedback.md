# TASK-049 feedback — admin second factor (own TOTP)
Status: PARTIAL — part a (storage, crypto, API) done; part b (enforcement, screens, reset CLI) follows in the next PR.

Spec: `docs/tasks/TASK-049-admin-mfa.md`. Decision: ADR-056.

## Part a — what I implemented
- `app.admin_mfa` (migration `0014_admin_mfa.sql`): one row per user, `secret_enc` (AES-256-GCM `v1.<iv>.<tag>.<ct>`), `confirmed_at`, `last_used_step`, `recovery_code_hashes text[]`. `eraseUser()` deletes the row.
- `apps/web/src/lib/auth/totp.ts` — pure: RFC 6238 TOTP (SHA-1, 6 digits, 30 s, ±1 step), base32, otpauth URI, HKDF keys from `SESSION_SECRET` (`secret-encryption`, `cookie`), AES-256-GCM, recovery codes (`XXXX-XXXX-XXXX`, 60 bits, SHA-256 of the normalised code).
- `apps/web/src/lib/auth/admin-mfa.ts` — enrol (upsert that only replaces an **unconfirmed** row; new id each time), confirm (first code → `confirmed_at`, 10 recovery codes returned once), verify (TOTP or recovery code), replay protection (`matchTotp` skips used steps + conditional `UPDATE … WHERE last_used_step < step`), single-use recovery codes (`array_remove … WHERE hash = any(…)`), the `cherrio_admin_mfa` cookie (HS256 JWT `{ sub, mfa: enrolment id }`, 12 h) and `hasValidMfa()`.
- Routes `POST /api/admin/mfa/enroll|confirm|verify` through `lib/auth/mfa-route.ts`: `requirePlatformAdminRole` (role only, 404 otherwise), origin check (403), `mfaRateLimiter` 10 / 15 min per user (429), `MfaError` → `{ error }` (409 / 400).
- `session.ts`: `requirePlatformAdminRole()` split out of `requireRole()` (which, in part a, still checks the role only); `getSecretKey()` exported for the HKDF input.

## Files changed (part a)
- `packages/db/src/schema/users.ts`, `packages/db/drizzle/0014_admin_mfa.sql` + snapshot/journal — table.
- `packages/db/src/gdpr.ts`, `packages/db/src/__tests__/integration.test.ts` — erase deletes the row; 25 tables.
- `apps/web/src/lib/auth/{totp,admin-mfa,mfa-route}.ts`, `apps/web/src/app/api/admin/mfa/{enroll,confirm,verify}/route.ts` — feature.
- `apps/web/src/lib/auth/session.ts`, `apps/web/src/lib/security/rate-limit.ts` — role-only check, limiter.
- `apps/web/src/types/qrcode.d.ts` — types for the one `qrcode` call.
- `apps/web/src/__tests__/{totp,admin-mfa-api}.test.ts`, `helpers/organizations.ts` (cleanup) — tests.
- Docs: ADR-056, this file, spec, `docs/technical/04` §5.4, `06` table, `09` §2 + task table, `docs/tasks/README.md`.

## Deviations
- none in scope. The QR code is a server-rendered SVG returned as a `data:` URL (rendered with `<img>`, no `innerHTML`).

## New dependencies
- `qrcode@1.5.4` (MIT) as a direct dependency of `apps/web` — already in the lockfile through Privy (`@privy-io/react-auth` → `qrcode@1.5.4`), so the lockfile grows by 3 lines and no new package is downloaded. No `@types/qrcode`: a 6-line declaration in `src/types/qrcode.d.ts`.

## Test results (part a, real outputs, 2026-10-07)
`pnpm exec vitest run src/__tests__/totp.test.ts src/__tests__/admin-mfa-api.test.ts`
```
 ✓ src/__tests__/admin-mfa-api.test.ts (7 tests) 488ms
 ✓ src/__tests__/totp.test.ts (15 tests) 17ms
 Test Files  2 passed (2)
      Tests  22 passed (22)
```
The TOTP tests use the six SHA-1 vectors of RFC 6238 Appendix B.

`pnpm --filter @cherrio/db test:integration` → `Tests  17 passed (17)` (25 tables; erase removes `admin_mfa`).

### Deliberate breaks (each restored with the reverse `sed`, then 22/22 green again)
1. Upsert without `setWhere: isNull(confirmed_at)` (a confirmed factor could be replaced):
   ```
   × /api/admin/mfa/* > a confirmed factor cannot be replaced by enrolling again (409) 40ms
   Tests  1 failed | 6 passed (7)
   ```
2. Used steps accepted again (`matchTotp` skip removed + DB condition removed):
   ```
   × /api/admin/mfa/* > verify: a code works once (replay refused), the next step works, a wrong code is 400 38ms
   × TOTP (RFC 6238, SHA-1) > refuses a step at or before the last used one (each code works once) 8ms
   Tests  2 failed | 20 passed (22)
   ```
3. Cookie not bound to the enrolment (`id === claims.mfa` removed):
   ```
   × /api/admin/mfa/* > the cookie belongs to one user and one enrolment 65ms
   Tests  1 failed | 6 passed (7)
   ```

## Open questions / risks
- Rotating `SESSION_SECRET` makes every stored secret undecryptable → admins re-enrol after `reset-admin-mfa` (part b). Documented in ADR-056 §3.
- The rate limiter is per container (like the other limiters); with one web container per environment that is the real limit.

## Suggested commit message
feat(auth): admin second factor — TOTP storage and API (TASK-049a, ADR-056)

# TASK-049 feedback — admin second factor (own TOTP)
Status: DONE — part a (storage, crypto, API) PR #134, live on dev; part b (enforcement, screens, reset CLI) PR #135, live on dev (Deploy 37573310590).

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


## Part b — what I implemented
- `requireRole("PLATFORM_ADMIN")` = role re-read from the DB **and** `hasValidMfa()` → throws `MFA_REQUIRED` (all ~25 admin pages and routes already answer 404 on any throw, so none needed a change). `requirePlatformAdminRole()` (role only) stays for the MFA routes and the admin layout.
- Admin layout: no role → 404 (unchanged); role, no confirmed factor → `AdminMfaGate mode="enrol"`; factor, no valid cookie → `AdminMfaGate mode="verify"`; else the page. After a successful code the gate calls `router.refresh()`, so the admin lands on the page they asked for.
- `components/admin/AdminMfaGate.tsx` + `admin.mfa.*` messages: "Show the QR code" → QR (`<img>` of the SVG data URL) + key in text → code → ten recovery codes (shown once) → "I saved them — continue". Code screen accepts a 6-digit or a recovery code.
- Logout clears `cherrio_admin_mfa`.
- `packages/db/src/reset-admin-mfa.ts` (+ `pnpm --filter @cherrio/db reset-admin-mfa`, bundle in `Dockerfile` next to grant-admin → `packages/db/dist/reset-admin-mfa.mjs`), audit `admin.mfa_reset` (actor null).
- Test helpers: Vitest `createUser({ admin: true })` and E2E `loginAsNewUser(…, { admin: true })` give the admin a confirmed factor and a valid cookie (`mfa: false` to opt out), so the existing admin tests keep testing their own feature.
- Docs: owner guide **v1.8** (§1 note, §10 "Admin sign-in"), README change log, PDF v1.8 (v1.7 removed); `technical/04` §5.4, `06`, `08` §5.0 (reset), `09`; `CHEATSHEET` §1; `runbooks/prod-launch.md` C step 4; `02-ARCHITECTURE.md` §3 line.

## Files changed (part b)
- `apps/web/src/lib/auth/session.ts`, `apps/web/src/app/[locale]/admin/layout.tsx`, `apps/web/src/components/admin/AdminMfaGate.tsx`, `apps/web/messages/en.json`, `apps/web/src/app/api/auth/session/route.ts` — enforcement, screens, logout.
- `packages/db/src/reset-admin-mfa.ts`, `packages/db/package.json`, `Dockerfile` — reset CLI.
- Tests: `admin-mfa-guard.test.ts` (new), `session-db`, `auth-api`, `admin-hidden`, `files-integration`, `admin-mfa-api`, `helpers/organizations.ts`; `e2e/admin-mfa.spec.ts` (new), `e2e/helpers/session.ts`; `packages/db` integration (reset).

## Deviations (part b)
- The spec's E2E list is covered by one spec walking the whole flow (enrol → codes → page → cookie gone → recovery code → recovery code refused the second time).
- UI checked with screenshots at 1440 and 390 (temporary spec, not committed): QR 220 px, recovery codes one column on phones, two from `sm`. The code font falls back to the serif in the sandbox (Google Fonts unreachable), as everywhere locally.

## Test results (part b, real outputs, 2026-10-07)
- `pnpm --filter web test` → `Test Files  57 passed (57)` / `Tests  502 passed (502)`.
- `pnpm --filter @cherrio/db test:integration` → `Tests  18 passed (18)`.
- Bundle smoke: `node dist/reset-admin-mfa.mjs` → `Usage: pnpm --filter @cherrio/db reset-admin-mfa <0x-address>` (exit 1); unknown address → `No user has this wallet address.` (exit 1).
- E2E: `CI=1 pnpm exec playwright test e2e/admin-mfa.spec.ts` → `2 passed (12.2s)`; whole suite except display currency → `178 passed (5.2m)` (all admin specs with the new helper).
- First E2E run of the new spec failed on my own expectation (it waited for "Admin Portal" while the gate correctly returned to `/en/admin/contracts`); fixed the expectation, not the code.

### Deliberate breaks (part b; restored with the reverse `sed`, then green)
4. `requireRole` without the factor check (`if (false && …)`):
   ```
   × … every admin API handler except /api/admin/mfa/* answers 404 to an admin without the factor 299ms
   × … requireRole authorization against DB > passes for a user with the role in DB and a valid second factor (ADR-056) 25ms
   AssertionError: POST api/admin/campaigns/[id]/chain-actions/route.ts: expected 400 to be 404
   Tests  2 failed | 5 passed (7)
   ```
5. One route (`lib/contracts/route.ts`, all Admin → Contracts routes) switched to the role-only check:
   ```
   × … every admin API handler except /api/admin/mfa/* answers 404 to an admin without the factor 586ms
   AssertionError: POST api/admin/contracts/changes/[id]/cancelled/route.ts: expected 400 to be 404
   Tests  1 failed | 1 passed (2)
   ```

## How David checks it on dev (after the deploy)
1. https://dev.cherr.io/en/admin → "Set up your authenticator" → "Show the QR code" → scan with Google Authenticator (the entry is named "CHERR.IO dev") → type the code → "Confirm".
2. Ten recovery codes appear once — save them → "I saved them — continue" → Admin Portal.
3. Log out and in again → https://dev.cherr.io/en/admin → "Confirm it is you" → code from the app → the page.

## Suggested commit messages
- feat(auth): admin second factor — TOTP storage and API (TASK-049a, ADR-056)
- feat(auth): require the admin second factor on every admin page and API (TASK-049b, ADR-056)

## Independent review (part b, read-only subagent, before merge)
Questions: can any admin page/route be reached without the factor; can a stolen session replace a confirmed factor (drizzle `setWhere` → `ON CONFLICT … DO UPDATE … WHERE confirmed_at IS NULL`, verified by rendering the SQL); replay/race; cookie binding and flags; crypto; does a page still execute when the layout returns the gate.
- **No critical/high findings.** All 11 admin pages and all 18 non-MFA admin routes go through `requireRole` with the request; the upsert cannot touch a confirmed row; codes and recovery codes are claimed atomically; the cookie key is HKDF-separate from the session key, `HS256` pinned, expiry set.
- **Pages do execute** when the layout returns the gate (App Router renders segments separately) — safe because every page calls `requireRole` before any data access or side effect. **Rule: the layout is UX only; every new admin page must keep its own `requireRole` check** (`admin-hidden.test.ts` enforces it).
- **Fixed in this PR:**
  - Medium — brute force across a 7-day stolen session (per-container limiter only, reset by restarts): **20 wrong codes per user per 24 h** counted in the audit log (`admin.mfa_failed`), then `429 locked` until the window passes.
  - Low — `authTagLength` not pinned: decryption now requires a 16-byte tag.
  - Low — ciphertext not bound to its user: user id as AES-GCM authenticated data.
  - Comment said "per IP" for a per-user limiter: corrected.
- **Accepted and documented (ADR-056 amendment):** first enrolment is trust-on-first-use (enrol right after the deploy; watch `admin.mfa_enrolled`); the MFA cookie is not tied to the session token (still needs the same user's valid session; logout deletes it in the browser); rotating `SESSION_SECRET` breaks every stored secret (verify answers 500) — reset every admin (`08-operations` §5.0).

### Deliberate breaks after the review fixes
6. 24-hour window ignored (`gt(createdAt, new Date(0))`): `AssertionError: expected 429 to be 400` — `Tests  1 failed | 7 passed (8)`.
7. Lock check removed: `AssertionError: expected 200 to be 429` — `Tests  1 failed | 7 passed (8)`.
8. Same AAD for every user: `× secret encryption > fails for a tampered value, another key, another user's row or a truncated tag` — `Tests  1 failed | 14 passed (15)`.

After restoring: `pnpm --filter web test` → `Test Files  57 passed (57)` / `Tests  503 passed (503)`.

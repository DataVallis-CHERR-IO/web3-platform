# TASK-025 — Auth: Privy login (email, Google, MetaMask), app session, account page, roles

Depends on: TASK-005 (DB), TASK-007 (web shell), TASK-022 (deploys).
Read first: `docs/00-MANIFEST.md`, `docs/03-DECISIONS.md` (**ADR-024** — supersedes the RainbowKit/Auth.js parts of ADR-003 and MANIFEST §4; ADR-014 GDPR; ADR-016 i18n; ADR-022 design), `docs/02-ARCHITECTURE.md` §3, `packages/db/src/schema/*` (users, user_addresses, user_roles, audit_log), `packages/db/src/gdpr.ts`, `apps/web` (layout, AppHeader, middleware, messages), `config/deploy*.yml`, `.kamal/secrets-common`, `.github/workflows/deploy.yml`, `docs/CHEATSHEET.md`.

## Goal
A visitor can log in with email (OTP), Google or MetaMask, gets a CHERR.IO account, sees and manages it on an account page, and can log out or delete the account. Platform admins are recognised by role. Navigation links no longer 404.

## Privy setup (already done by David)
- App "CHERR.IO dev", App ID `cmup9dfcd00ct0cjsvqkzm9q9` (public). App Secret is in David's password manager — you never see it.
- Login methods: email, Google, external wallets. Embedded wallets: create on login for users without a wallet.
- Allowed origins: `https://dev.cherr.io`, `http://localhost:3000`.

## Scope

### 1. Config (runtime, not build time)
- New env vars: `PRIVY_APP_ID` (plain), `PRIVY_APP_SECRET` (secret), `SESSION_SECRET` (secret, 32-byte hex). Add to `packages/shared` env schema (zod), `.env.example` (placeholders only), Kamal destinations (`env.clear` / `env.secret`), `.kamal/secrets-common` (references only) and the deploy workflow env blocks.
- The client gets the App ID from the server (root layout reads it and passes it to the provider). No `NEXT_PUBLIC_PRIVY_*`, so one image works for any env.
- The app must start without these vars in CI/e2e (login button disabled with a translated notice); it must fail loudly at startup in dev/uat/prod if they are missing.

### 2. Client
- `@privy-io/react-auth` provider in a client component wrapping the app; appearance matched to the design system (square corners, brand colours, our logo) as far as Privy allows.
- Login methods order: email, Google, wallet (MetaMask/injected). Chain: Polygon Amoy for dev/uat (from `getChainConfig`), Polygon for prod.
- Header: "Log in" opens the Privy modal; when logged in, show a compact account button (display name or short address) with a menu: My account, Log out. Mobile Sheet nav gets the same.

### 3. Server session
- `POST /api/auth/session`: body = Privy access token. Verify with `@privy-io/server-auth` (signature, app id, expiry). On success:
  - upsert `users` by `privy_did` (create on first login; `display_name` default from email local-part or short address; `locale` from route);
  - upsert `user_addresses` for every wallet on the Privy user (embedded → `EMBEDDED`, external → `EXTERNAL`; lowercase; first one `is_primary`). If an address already belongs to a different user → 409 with a translated message, no change;
  - store email only if Privy returns one;
  - write `audit_log` (`auth.login`, actor = user, ip);
  - set cookie `cherrio_session`: JWT (jose, HS256, `SESSION_SECRET`), payload `{ sub: userId, roles, iat, exp }`, 7 days, `HttpOnly`, `Secure` (except local), `SameSite=Lax`, `Path=/`.
- `DELETE /api/auth/session`: clear the cookie (+ `audit_log` `auth.logout`). The client also calls Privy `logout()`.
- `getSession()` server helper (reads + verifies the cookie, returns `{ userId, roles }` or null) and `requireUser()` / `requireRole('PLATFORM_ADMIN')` helpers that **re-read roles from the DB** (never trust cookie roles for authorisation).
- On Privy logout/expired token the client calls DELETE so both sessions end together.
- Basic rate limit on `/api/auth/session` (in-memory per IP, e.g. 20/min) — documented as per-container.

### 4. Pages (all strings via next-intl, design-system components only)
- `/[locale]/account` (requires login → redirects to `/[locale]` and opens login if not):
  - display name (editable, 2–40 chars), email (read-only, from Privy), "Show me as anonymous on donations" toggle (`anonymous_donations`);
  - linked wallets list using the `Address` component with type label (Embedded / External) and primary badge; "Link another wallet" (Privy `linkWallet`) and "Unlink" for non-primary external wallets — both sync to `user_addresses` via an authenticated API;
  - "Delete my account": confirm Dialog → server calls `eraseUser(db, userId)` (TASK-005) **and** deletes the Privy user via server API, clears the session, `audit_log` `account.deleted`. Explain in the dialog that on-chain donations stay public on the blockchain but are no longer linked to their name.
- `/[locale]/admin`: placeholder visible only to `PLATFORM_ADMIN` (404 for everyone else — do not reveal it exists). Shows "Admin — coming in TASK-021" and the logged-in admin's id.
- "Coming soon" page for every nav target that does not exist yet: `/campaigns`, `/charity-market-cap`, `/emergency-pool`, `/how-it-works`, plus footer links (`/about`, `/docs`). One shared component, translated, with a link back home. No more 404s from our own navigation.

### 5. Admin bootstrap
- Extend the seed (idempotent) so `SEED_ADMIN_ADDRESS` gives `PLATFORM_ADMIN` to the user who owns that address **once the user has logged in**. Add a script `pnpm --filter @cherrio/db grant-admin <address>` (direct DB URL) that does exactly that and is safe to rerun. Document the command for dev (via `kamal app exec`) in the feedback and in `docs/CHEATSHEET.md` §1.

### 6. Security
- Never log tokens, cookies or emails. Cookie flags as above. CSRF: session-changing routes accept only `POST/DELETE` with `Content-Type: application/json` and check `Origin` against the env host.
- Add a CSP-compatible setup for Privy (document the domains it needs; full CSP comes later).
- Dependencies allowed: `@privy-io/react-auth`, `@privy-io/server-auth`, `jose`. Anything else: ask first.

## Tests
- Unit: session cookie sign/verify/expiry; role helpers re-read DB; address-conflict 409; Origin check.
- Integration (local Postgres): first login creates user + addresses; second login is idempotent; link/unlink; delete account calls `eraseUser` and leaves no `user_addresses`.
- Privy is mocked in unit/integration tests (no network).
- E2E (Playwright): header "Log in" opens the Privy modal (or shows the disabled notice when no App ID); `/en/account` redirects when logged out; `/en/admin` returns 404 when logged out; every nav link returns 200 (coming-soon pages). axe passes on the new pages in both themes.

## Must not touch
`packages/contracts/**`, `docs/**` (except feedback and the CHEATSHEET §1 admin line), DB schema (no migrations needed — if you think one is, stop and ask).

## Acceptance criteria
- On dev.cherr.io: log in with email, with Google and with MetaMask; the account page shows the right wallets; log out; log in again → same user.
- `PLATFORM_ADMIN` sees `/en/admin`; others get 404.
- No nav link returns 404.
- `pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm check:design && pnpm test:e2e` pass; Docker build passes.
- Feedback lists the exact GitHub secrets/vars David must add per environment and how to generate `SESSION_SECRET`.

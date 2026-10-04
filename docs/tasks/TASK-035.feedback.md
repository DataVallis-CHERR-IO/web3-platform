# TASK-035 feedback
Status: DONE — Live on dev (PR #75, Deploy run 37193268534)

## What I implemented
- `src/lib/security/admin-area.ts`: `isAdminPath()` (`/admin…`, `/<locale>/admin…`, `/api/admin…`) and the admin headers.
- `middleware.ts`: every admin response in **every** environment (prod included) gets `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` and `Cache-Control: private, no-store`. Non-prod public pages keep `noindex, nofollow`; prod public pages get no robots header.
- `app/[locale]/admin/layout.tsx`: one guard for the whole admin area — `requireRole("PLATFORM_ADMIN")` → `notFound()` — plus `robots` metadata noindex. Every page keeps its own check (a client navigation between admin pages does not re-run the layout).
- `app/[locale]/not-found.tsx` + `app/[locale]/[...rest]/page.tsx`: one localized 404 page ("This page does not exist"). Before, an unknown URL rendered Next's bare default 404 while a hidden admin page rendered a 404 inside the site layout — the two could be told apart. Now they are the same page with the same status.
- `robots.txt`: prod `User-agent: *` / `Allow: /` (David: AI crawlers may read public pages); other environments `Disallow: /` for `*` and by name for 14 AI crawlers. `/admin` is never named.

## Files changed
- apps/web/src/lib/security/admin-area.ts, robots.ts (new)
- apps/web/src/middleware.ts, apps/web/src/app/robots.txt/route.ts
- apps/web/src/app/[locale]/admin/layout.tsx, not-found.tsx, [...rest]/page.tsx (new)
- apps/web/messages/en.json — `notFoundPage.*`
- apps/web/src/__tests__/admin-hidden.test.ts (9 tests), apps/web/e2e/admin-hidden.spec.ts (3 tests)
- docs/technical/04, 06, 09; docs/tasks/README.md, TASK-035-admin-hidden.md

## Deviations from the task (and why)
- `<meta name="robots">` comes from the admin layout's `metadata`, not a hand-written tag (Next renders it).
- No change to the owner guide: Admin → Contracts behaves the same for admins.

## New dependencies
- none

## How to verify
1. `pnpm --filter web exec vitest run src/__tests__/admin-hidden.test.ts` → 9 passed.
2. On dev, logged out: https://dev.cherr.io/en/admin/contracts shows "This page does not exist" (404), exactly like https://dev.cherr.io/en/this-page-does-not-exist. Logged in as admin: the console as before.
3. `curl -sI https://dev.cherr.io/en/admin` → `x-robots-tag: noindex, nofollow, noarchive, nosnippet`, `cache-control: private, no-store`.

## Test results (this session)
- `vitest run src/__tests__/admin-hidden.test.ts`: `Tests  9 passed (9)`
- Deliberate break 1 (middleware admin headers disabled): `× middleware headers > prod: every admin page and API response says noindex and no-store`, `× … dev: …` → `Tests  2 failed | 7 passed (9)`; restored.
- Deliberate break 2 (`lib/contracts/route.ts` lets an anonymous request through): `AssertionError: POST api/admin/contracts/changes/[id]/cancelled/route.ts: expected 403 to be 404` → `Tests  1 failed | 8 passed (9)`; restored.
- `pnpm --filter web test`: `Test Files  38 passed (38)`, `Tests  361 passed (361)`
- `pnpm build` OK; E2E full suite: `136 passed (3.4m)` (admin-hidden, admin-overview, contract-console first: `14 passed (33.9s)`)
- typecheck, lint, `pnpm check:design` clean.

## Open questions / risks
- The JS bundles still contain admin route names (Next ships client components of admin pages as separate chunks, loaded only on admin pages). Knowing a path gives nothing: every request answers 404 without the role.
- Basic auth / Privy allow-list for dev/uat (06 §7 "dev/uat access") stays Planned.

## Suggested commit message
feat(security): admin area hidden from crawlers and outsiders (TASK-035)

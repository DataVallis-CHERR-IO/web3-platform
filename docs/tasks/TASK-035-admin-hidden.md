# TASK-035 — Admin pages invisible to search engines, AI crawlers and outsiders

Status: Planned (recorded 2026-10-04, David)
Depends on: TASK-025 (auth), TASK-034 (Admin → Contracts)

## Request (David, 2026-10-04)
> Admin pages are only for us, the owners of the CHERR.IO platform (contracts etc.). They must not be indexed by browsers/search engines or AIs; everything must be blocked, as if the page did not exist.

## State today (code survey 2026-10-04)
- Every `/[locale]/admin/**` page calls `requireRole("PLATFORM_ADMIN")` itself and answers **404** (`notFound()`) to everyone else; every `/api/admin/**` route answers 404 too (`apps/web/src/lib/contracts/route.ts` and the other admin handlers). So for an outsider the pages already look non-existent.
- Gaps:
  1. **No common guard.** The check is per page; a new admin page that forgets it would be public.
  2. **Prod sends no `noindex`.** `middleware.ts` sets `X-Robots-Tag: noindex, nofollow` only when `APP_ENV != prod`; `robots.txt` on prod is `Allow: /`.
  3. **No AI-crawler rule** (GPTBot, ClaudeBot, CCBot, Google-Extended, PerplexityBot, …) — only `User-agent: *`.
  4. Admin pages may be linked from client code (route names in JS bundles) — check what is exposed.

## Scope (to be planned in detail when started)
- One guard for the whole admin area (middleware and/or an `admin/layout.tsx`): no valid admin session → the same 404 as any unknown URL, before any admin code renders. Keep the per-page checks (defence in depth) and add a test that fails if any admin page or route renders without the role.
- `X-Robots-Tag: noindex, nofollow, noarchive` on every `/admin` and `/api/admin` response in **every** environment, plus `<meta name="robots" content="noindex, nofollow">` in the admin layout.
- `robots.txt`: do **not** list `/admin` (that would advertise the path); instead add explicit `Disallow: /` groups for known AI crawlers on non-prod and decide the prod policy for AI crawlers on public pages with David (product decision).
- `Cache-Control: private, no-store` on admin responses (no CDN or shared cache copies).
- E2E: anonymous and non-admin users get 404 with `noindex` on every admin URL; the 404 is indistinguishable from an unknown path (same status, same body).
- Docs: `06-security.md`, `04-web-app-and-auth.md`, owner guide note if Admin → Contracts behaviour changes.

## Open decision for David
- Should public pages on prod allow AI crawlers (visibility in AI answers) or block them? Admin is blocked either way.

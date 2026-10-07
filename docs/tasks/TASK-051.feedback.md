# TASK-051 feedback
Status: DONE

## What I implemented
- `.ch-view-nav` (`packages/ui/src/styles/components.css`): flex row with wrap on desktop (same as the old `flex flex-wrap gap-2`); at ≤ 640 px a framed column, one view per row (min 48 px, label left, count right, 2 px separators, no hard shadow or press shift), the current view keeps the accent fill and gets an underline.
- Applied to the view tabs of `/en/admin/campaigns` and `/en/admin/organizations`.
- Guard spec `apps/web/e2e/admin-view-nav.spec.ts` (both projects).

## Files changed
- `packages/ui/src/styles/components.css` — new `.ch-view-nav` rules
- `apps/web/src/app/[locale]/admin/campaigns/page.tsx` — nav uses `.ch-view-nav`
- `apps/web/src/app/[locale]/admin/organizations/page.tsx` — nav uses `.ch-view-nav`
- `apps/web/e2e/admin-view-nav.spec.ts` — new guard
- `docs/technical/04-web-app-and-auth.md`, `docs/technical/09-status-and-roadmap.md`, `docs/tasks/README.md` — docs

## Deviations from the task (and why)
- none

## New dependencies
- none

## How to verify
1. On dev, log in as admin on a phone (or 390 px wide window): https://dev.cherr.io/en/admin/campaigns
2. Expected: a bordered box with six rows — "Waiting for review (n)" filled red, then "Approved — waiting to be published", "Live", "Not accepted", "Drafts", "All", each with its count at the right edge. Same box with five rows on https://dev.cherr.io/en/admin/organizations.
3. On a desktop both pages look as before (one row of tabs).

## Test results
Screenshots at 390 and 1440 before and after (temporary Playwright spec, not committed): before — wrapped tabs of uneven widths, count of "Approved — waiting to be published" hanging right of a two-line label; after — one row per view at 390, desktop identical.

Guard spec, related specs (local, this session):
```
CI=1 pnpm exec playwright test e2e/admin-view-nav.spec.ts --retries=0
  2 passed (11.6s)
CI=1 pnpm exec playwright test e2e/admin-view-nav.spec.ts e2e/admin-overview.spec.ts e2e/a11y.spec.ts --retries=0
  76 passed (2.3m)
pnpm check:design            → Design check passed — no violations found.
vitest design-classes.test.ts → Tests  2 passed (2)
pnpm --filter web lint / typecheck → clean
```

Deliberate break 1 — mobile frame rule disabled (`.ch-view-nav` → `.ch-view-nav-BROKEN` inside the media query), rebuilt:
```
Error: /en/admin/campaigns tab 0 width
Expected: <= 1
Received:    6
  1 failed
  1 passed (11.3s)
```
Deliberate break 2 — the campaigns page back on `className="flex flex-wrap gap-2"`, rebuilt:
```
Error: /en/admin/campaigns tab 0 width
Expected: <= 1
Received:    81.3125
  1 failed
  1 passed (13.1s)
```
Both restored; the guard passes again (76 passed above was run after restoring).

## Open questions / risks
- none

## Suggested commit message
fix(web): admin view tabs as a one-per-row list on phones (TASK-051)

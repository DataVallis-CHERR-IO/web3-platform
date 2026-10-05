# TASK-041 feedback
Status: DONE (Built; Live on dev after merge + deploy)

## What I implemented
- Filter panel (`apps/web/src/app/[locale]/campaigns/page.tsx`, `.ch-filter*` in `packages/ui/src/styles/components.css`): framed panel with a hard shadow, rows `Cause` / `Country` in a 112px label column, chips 40px high with a mono count cell (`aria-hidden`; the link's accessible name stays "Animals (2)" through `aria-label`), active chip ink-filled, hover lift like the campaign cards, country select with `appearance: none` and a sunken chevron cell, result bar ("2 CAMPAIGNS" · "Clear filters"). Phones (≤ 640px): labels above the controls, chips in one row that scrolls sideways, select full width.
- `.ch-container`: `max-width: 1440px; margin-inline: auto; padding-inline: 64px` (24px at ≤ 1024px). Fixes the edge-to-edge account, admin, organisation-form and notification pages.
- `apps/web/src/__tests__/design-classes.test.ts`: collects `ch-*` tokens from `className="…"`, ``className={`…`}`` and `cn(…)` in `apps/web/src` and `packages/ui/src` and fails for any class without a rule in the shared CSS.

## Files changed
- `apps/web/src/app/[locale]/campaigns/page.tsx` — filter markup
- `packages/ui/src/styles/components.css` — filter panel styles, `.ch-container`
- `apps/web/src/__tests__/design-classes.test.ts` — new guard
- `docs/tasks/TASK-041-design-polish.md`, `docs/tasks/README.md`, `docs/technical/04-web-app-and-auth.md`, `docs/technical/09-status-and-roadmap.md` (also TASK-039 → Live on dev, PR #105, Deploy 37275960895)

## Deviations from the task (and why)
- none. On phones the active chip can sit off-screen in the scrolling row (no JavaScript to scroll it into view); the result bar and the URL still show the filter.

## New dependencies
- none

## How to verify
On dev after the deploy: https://dev.cherr.io/en/campaigns → a framed "Cause / Country" panel with chips like "Animals | 2" and a grey bar "N CAMPAIGNS"; https://dev.cherr.io/en/admin → content starts 64px from the left edge, aligned with the header logo area of the public pages.

## Test results (real outputs, this session, 2026-10-05)
`pnpm exec vitest run src/__tests__/design-classes.test.ts`:
```
 ✓ src/__tests__/design-classes.test.ts (2 tests) 14ms
      Tests  2 passed (2)
```
Deliberate break (both `.ch-container` rules removed), then restored:
```
   × design-system classes > every ch-* class used in a component is defined in the shared CSS 22ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
+   "ch-container (apps/web/src/app/[locale]/account/AccountClient.tsx)",
+   "ch-container (apps/web/src/app/[locale]/account/campaigns/[id]/page.tsx)",
```
(A first attempt removed only the base rule; the test still passed because the media-query rule also defines the class — so the break was redone with both rules removed.)

Web unit suite: `Tests  462 passed (462)`; typecheck and lint exit 0; `pnpm check:design` → "Design check passed — no violations found.".

Full E2E after `pnpm build` (`CI=1 pnpm exec playwright test --retries=0`): `166 passed (5.4m)`.

Screenshots (1440 and 390, light theme) of `/en/campaigns?cause=animals` and `/en/admin/campaigns` were checked in the session (temporary spec, not committed).

## docs/technical chapters updated
- `04-web-app-and-auth.md` (§3 page container + guard; `/en/campaigns` filter panel)
- `09-status-and-roadmap.md` (TASK-041 row; TASK-039 Live on dev)

## Suggested commit message
feat(ui): filter panel layout and the missing page container (TASK-041)

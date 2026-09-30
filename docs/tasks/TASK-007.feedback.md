# TASK-007 Feedback — Web Shell + Design System

Status: DONE

## What was missing in round 1 and fixed in round 2

Round 1 delivered the token pipeline, components, and a basic landing page but had these gaps:

1. **Landing page did not follow `Main.dc.html` mockup** — was a generic layout. Fixed: now implements all 7 sections (hero with featured card, 3-step how-it-works, campaigns grid with filter buttons, Charity Market Cap teaser with table, Emergency Pool band, header, footer) exactly per the mockup.

2. **App shell incomplete** — header lacked Cherry wordmark image, nav links, mobile Sheet (<768px), skip link to `#main`. Footer lacked white wordmark on ink background, "Data Vallis" credit, ThemeToggle. Fixed all.

3. **`/dev/ui` guard used wrong values** — guarded on `"production"` string instead of the allow-list `local|dev`. CI used `APP_ENV=staging` (not a valid value). Fixed: guard is now `appEnv !== "local" && appEnv !== "dev"` → `notFound()`. CI uses `APP_ENV=dev`. Unit test verifies `APP_ENV=uat` returns 404.

4. **`check:design` missed attribute strings** — did not catch hardcoded strings in `aria-label`, `title`, `alt`, `placeholder`. Fixed: extended script regex to cover these attributes.

5. **E2E tests broken** — `networkidle` caused 60s timeouts; `__dirname` undefined in ESM; no horizontal-scroll test at 360px; a11y violations (aria-prohibited-attr on `<span>` without role, color-contrast on EP tagline and ledger links). Fixed all.

6. **Feedback was dishonest** — said "Deviations: None" which was false. Rewritten.

## What was fixed in round 3

1. **Header wordmark invisible in dark mode** — dark ink SVG on dark `surface-raised` background. Fixed: header now shows two `<img>` elements (ink + white) toggled via CSS `[data-theme="dark"]` and `@media (prefers-color-scheme: dark)` — no JS, no flash.

2. **Footer lost ink background in dark mode** — semantic tokens `--ink`/`--surface` swap in dark theme, so footer bg became light and white wordmark disappeared. Fixed: footer CSS now uses theme-independent palette vars (`--slate-900` bg, `--mist-100` text, `--mist-300` credit). Copyright text contrast: mist-300 on slate-900 = 5.22:1 (both themes, AA pass).

3. **CampaignCard meta showed bare numbers** — grid cards displayed "88   14" without labels. Fixed: grid now constructs `metaLabel` from ICU plural translations (`"{count, plural, one {# donor} other {# donors}}"` / `"{count, plural, one {# day left} other {# days left}}"`) and passes it to each card. Card foot renders `metaLabel` instead of bare numbers. Gallery card also updated.

4. **No featured card in grid** — all 4 sample campaigns had `featured: false`. Fixed: first campaign ("Winter shelter for 40 dogs") now has `featured: true`, receiving `shadow-hard` via `.ch-card-featured`.

5. **Theme toggle styling in footer** — added `.ch-footer .ch-btn-ghost { color: var(--mist-100); }` so the toggle button text is visible against the dark footer in both themes.

## What I implemented

- Token pipeline (`build-tokens.ts` → `tokens.css` → `theme.css`)
- Design guard script with attribute-string checking
- All 11 design-system components + 6 Radix primitives (components.css)
- Money types with bigint (money.ts, 29 tests)
- App shell: header (wordmark with dark-mode swap, nav, mobile Sheet, skip link), footer (ink bg always, white wordmark, Data Vallis, ThemeToggle)
- Landing page matching `Main.dc.html` mockup (7 sections)
- `/dev/ui` gallery with APP_ENV allow-list guard + unit test
- Playwright + axe E2E: a11y, screenshots, no-Google-Fonts, no-horizontal-scroll
- CI workflow updates

## Files changed (round 3 additions)

- `packages/ui/src/styles/components.css` — footer uses `--slate-900`/`--mist-100`/`--mist-300` (theme-independent); header wordmark light/dark toggle CSS; `.ch-footer .ch-btn-ghost` color override
- `apps/web/src/components/AppHeader.tsx` — two wordmark images (ink + white) with CSS class toggles
- `packages/ui/src/components/CampaignCard.tsx` — card foot renders `metaLabel` instead of bare donors/daysLeft numbers
- `apps/web/src/app/[locale]/page.tsx` — constructs metaLabel from ICU plurals for each grid card
- `apps/web/src/app/[locale]/dev/ui/page.tsx` — passes metaLabel to gallery CampaignCard
- `apps/web/messages/en.json` — donorsCount/daysLeft converted to ICU plural syntax
- `apps/web/src/fixtures/landing.ts` — first campaign set to `featured: true`

## Deviations from the task (and why)

1. **Ledger links use `var(--ink)` instead of `var(--accent-text)`** — the token docs explicitly say cherry-500 is 3.05:1 on slate-700 and to "use ink there". Changed to pass WCAG AA contrast. Links retain underline + bold for affordance.
2. **EP tagline uses `var(--line-soft)` instead of `var(--ink-muted)`** — ink-muted on ink background fails contrast in both themes. `line-soft` (mist-300 light / slate-500 dark) passes 4.96:1 and 5.91:1 respectively.
3. **Footer uses theme-independent palette vars** — semantic tokens (`--ink`, `--surface`) swap in dark mode, making the footer light. Using `--slate-900`/`--mist-100` directly keeps the footer always dark as per the mockup.

## New dependencies

- `vitest@^3.0.5` (devDependency in apps/web) — already used in packages/shared and packages/db; needed for unit-testing the APP_ENV guard.

## How to verify

1. `pnpm build` — all 8 tasks pass
2. `pnpm lint` — all 8 tasks pass
3. `pnpm typecheck` — all 8 tasks pass
4. `pnpm --filter web --filter @cherrio/shared test` — 41 tests pass (35 shared + 6 web)
5. `pnpm check:design` — zero violations
6. `cd apps/web && APP_ENV=dev pnpm test:e2e` — 20 tests pass (a11y × 4 themes/pages, screenshots × 8, horizontal-scroll × 2, no-Google-Fonts × 2)
7. Verify 8 screenshots in `apps/web/e2e/screenshots/` (home-light/dark × 1440/390, gallery-light/dark × 1440/390)

## Test results

```
pnpm build         → 8 successful
pnpm lint          → 8 successful
pnpm typecheck     → 8 successful
pnpm test (web)    → 1 file, 6 tests passed
pnpm test (shared) → 2 files, 35 tests passed
pnpm check:design  → zero violations
pnpm test:e2e      → 20 passed (0 failed)
```

Screenshots (8 files):
- `home-light-chromium-1440.png`
- `home-light-chromium-390.png`
- `home-dark-chromium-1440.png`
- `home-dark-chromium-390.png`
- `gallery-light-chromium-1440.png`
- `gallery-light-chromium-390.png`
- `gallery-dark-chromium-1440.png`
- `gallery-dark-chromium-390.png`

## Open questions / risks

- `@cherrio/db` tests fail due to no local Postgres — pre-existing, unrelated to TASK-007.
- `metadataBase` warning in Next.js build — OG/social images will need a real base URL when deployed.

## Suggested commit message

feat(web,ui): complete web shell, landing page, design system (TASK-007 round 3)

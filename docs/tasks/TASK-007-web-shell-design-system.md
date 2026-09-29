# TASK-007 — Web shell + design system in code

Depends on TASK-001 (and TASK-005 only for types; no DB access needed here).
Read first: `docs/00-MANIFEST.md` (Design system section), ADR-016, ADR-022, `packages/ui/design-system/README.md` (the brand book — **read it fully**), every `packages/ui/design-system/components/*/README.md`, and the mockup sources in `docs/design/mockups/*.dc.html`.

## Goal
The design system lives in code: tokens, fonts, the 11 CHERR.IO components as typed React, a restyled shadcn/ui base, an app shell, and the landing page built from the mockup. Everything after this task builds only from these parts.

## Inputs in the repo
- `packages/ui/design-system/` — exported system: `tokens.json`, `tokens.css`, `README.md`, `components/bundle.js` (reference implementation), `components/bundle.css` (reference styles), `components/index.d.ts` (props), `components/<Comp>/README.md` (usage rules), `assets/files/*` (logos, token art).
- `docs/design/mockups/` — the four mockup screens as HTML with inline styles (`Main` = landing, `Campaign` = campaign detail, `MarketCap`, `CampaignMobile` = donor vote). They reference `x-import component-from-global-scope="Cherrio.X"` = your `X` component. Treat them as the visual spec, not as code to copy.

## Scope

### 1. Tokens → CSS + Tailwind v4
- `packages/ui/scripts/build-tokens.ts`: reads `design-system/tokens.json`, writes `packages/ui/src/styles/tokens.css`:
  - `:root` = light values; `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {…} }` and `:root[data-theme="dark"] {…}` = dark values; aliases `{x}` → `var(--x)`.
  - spacing, radius, border, shadow (per theme), font families.
- `packages/ui/src/styles/theme.css` with Tailwind v4 `@theme inline` mapping tokens to utilities (`bg-surface`, `text-ink`, `border-line`, `bg-accent`, `text-on-accent`, `shadow-hard`, `font-display`, `font-mono`, spacing scale, `--radius-*: 0`). Remove every Tailwind default colour so non-token colours cannot be used (`--color-*: initial;` first).
- Add `pnpm --filter ui tokens` script; CI fails if generated file is out of date (`git diff --exit-code` after running it).

### 2. Fonts (GDPR: no requests to Google at runtime)
- `next/font/google` for **Archivo Black** (400), **Archivo** (400, 500, 700, 800), **IBM Plex Mono** (400, 500), `display: swap`, exposed as `--font-display`, `--font-sans`, `--font-mono`. Remove the `@import` of Google Fonts from any CSS you port.

### 3. Components (`packages/ui/src/components/`)
Port all 11 from `bundle.js` + `bundle.css` to typed React (TSX, server-component-safe where no state):
`Button`, `StatusChip`, `Field`, `Progress`, `CampaignCard`, `ProofLink`, `MilestoneTrack`, `VoteMeter`, `TrustScore`, `LedgerTable`, `Address`.
- Props exactly as `index.d.ts`, plus: `Progress`, `CampaignCard`, `MilestoneTrack` accept money as **`{ eurCents: bigint }` or `{ usdc: bigint }`** via a `Money` type from `packages/shared/money.ts` (add `formatEur`, `formatUsdc`, `usdcToEurCents(usdc, rate)`; tests). No floats for money.
- Styles: port `bundle.css` as `packages/ui/src/styles/components.css` (keep `ch-` class names) OR Tailwind classes — your choice, but the rendered result must match the reference pixel-for-pixel in structure (borders, shadows, spacing, type sizes). Justify the choice in feedback.
- **All visible strings via next-intl**: components take translated labels or call `useTranslations('ui')`; add keys to `apps/web/messages/en.json` (`ui.status.live = "Raising"`, … exactly the labels in `StatusChip/README.md`; `ui.proof.default = "Verified on blockchain"`, VoteMeter sentences, MilestoneTrack states).
- `Address` copy button: `navigator.clipboard` with graceful failure; `LedgerTable` explorer base from `getChainConfig(APP_ENV)`.
- Accessibility: real buttons/links/labels, focus ring per README, `role="progressbar"` with values, glyphs `aria-hidden`.

### 4. shadcn/ui base
- Init shadcn/ui in `packages/ui` for primitives the system doesn't cover (Dialog, Sheet, Select, Tabs, Tooltip, DropdownMenu, Toast). Restyle each: radius 0, `border-bold` in `line`, `shadow-hard` only on Dialog, labels in `label` style. Do not ship shadcn's Button/Input/Badge — use the system's.

### 5. App shell (`apps/web`)
- `[locale]/layout.tsx`: header (cherry wordmark → home, nav: Campaigns, Charity Market Cap, Emergency Pool, How it works; right: Log in placeholder button — auth is TASK-025), footer (white wordmark on ink, "Operated by Data Vallis d.o.o., Maribor, Slovenia"), skip link, `lang` attribute from locale.
- Favicon/app icons from `cherrio-symbol-cherry.svg`. Metadata defaults + Open Graph image placeholder.
- Theme: light default, dark via system preference and a toggle in the footer storing a cookie (no flash: set `data-theme` server-side from the cookie).
- Mobile: nav collapses into a Sheet; gutter 16px; no horizontal scroll at 360px.

### 6. Landing page `/[locale]`
Build `Main.dc.html` as real React using the components and a typed fixtures file `apps/web/src/fixtures/landing.ts` (clearly named sample data, replaced by DB data in TASK-011). Sections: hero, featured campaign card, 3-step "how it works", campaigns grid, Charity Market Cap teaser, Emergency Pool band. Photo placeholders stay as labelled grey blocks.

### 7. Component gallery `/[locale]/dev/ui`
Renders every component in all states in light and dark (side by side). **Only available when `APP_ENV` is `local` or `dev`** (404 otherwise).

## Must not touch
`docs/**` (except feedback), `packages/contracts/**`, `packages/db/**`, `apps/indexer/**`, `apps/worker/**`, `packages/ui/design-system/**` (read-only reference).

## Allowed dependencies
`@radix-ui/*` (via shadcn), `lucide-react`, `clsx`, `tailwind-merge`, `class-variance-authority`, `tsx` (for the token script), `@axe-core/playwright`.

## Acceptance criteria
- `pnpm build && pnpm lint && pnpm typecheck && pnpm test` pass; tokens script output committed and CI check added.
- `/en` matches the landing mockup in structure and styling at 1440px and works at 390px with no horizontal scroll.
- `/en/dev/ui` shows all 11 components × states × both themes; hidden in uat/prod.
- Playwright + axe: no serious/critical violations on `/en` and `/en/dev/ui` in both themes.
- `grep` finds no hard-coded hex colours, `rounded-*` classes, or user-facing strings outside message files in `apps/web/src` and `packages/ui/src` (except token generation).
- No request to fonts.googleapis.com at runtime (check network in Playwright).
- Feedback includes screenshots (light + dark, desktop + mobile) of `/en` and `/en/dev/ui`.

# TASK-045 feedback — campaign card polish
Status: DONE

David, 2026-10-05 (screenshot of https://dev.cherr.io/en/campaigns, display currency POL): the progress bar sticks out of the cards, "≈ 0.00 POL (0.00 USDC)" sticks out too; the cards' type is too big, the title too.

## What I implemented
- **Root cause:** `.ch-card-body` was a grid with an implicit `auto` column. Grid items have `min-width: auto`, so the nowrap figure "≈ 0.00 POL (0.00 USDC)" at 28px set the column wider than the card, and the bar (width 100 % of the column) followed it past the right border.
- `.ch-card-body` → `grid-template-columns: minmax(0, 1fr)`; `.ch-card-org` `min-width: 0`; `.ch-card-title` `overflow-wrap: anywhere`.
- `components/Amount.tsx` `Converted`: "≈ figure" and "(original)" are each unbroken, but the original may wrap under the figure (was one nowrap span).
- Card scale (cards only; campaign page unchanged): org 13/18px, title 24/28 → 19/24px, raised 28/32 → 20/24px, target 13px, meta 12/16px, bar 28 → 18px (tick −6px).
- `Progress` (packages/ui) renders no fill element at 0 % — its 3px right border showed as a black stub at the start of every empty bar (visible in David's screenshot).

## Files changed
- `packages/ui/src/styles/components.css` — card grid column + card scale.
- `packages/ui/src/components/Progress.tsx` — no fill at 0 %.
- `apps/web/src/components/Amount.tsx` — wrap between converted figure and original.
- `apps/web/e2e/campaign-card-layout.spec.ts` — new guard (POL rates, indexed raised 12,345,678.91 USDC → "≈ 107,074,405.14 POL (12,345,678.91 USDC)"; bar, figures, meta and title right edges ≤ card's; body has no horizontal overflow; 1440 and 390).
- `apps/web/src/__tests__/progress-figures.test.tsx` — no fill at 0 %, 1 % fill at 1 %.
- `docs/technical/04-web-app-and-auth.md`, `docs/technical/09-status-and-roadmap.md`, `docs/tasks/README.md`.

## Deviations
- No separate spec file: a small design fix asked by David directly.

## How to verify on dev (after deploy)
1. https://dev.cherr.io/en/campaigns with currency POL in the header.
2. Every card: the bar ends inside the card; "≈ 0.00 POL (0.00 USDC)" is inside (a long amount puts "(… USDC)" on a second line); smaller title and figures; empty bars have no black stub at the left.

## Test results (real, 2026-10-05 sandbox)
- `vitest run src/__tests__/progress-figures.test.tsx` → `Tests  3 passed (3)`.
- `pnpm build` + `playwright test e2e/campaign-card-layout.spec.ts e2e/campaigns.spec.ts e2e/campaign-pages.spec.ts e2e/landing.spec.ts e2e/campaign-filters.spec.ts e2e/display-currency.spec.ts --retries=0` → `17 passed`, `1 failed` (display-currency 1440, leftover POL rates from my screenshot run in the reused DB — the known HANDOFF trap); after `delete from app.fx_rates` → `display-currency.spec.ts 2 passed (11.4s)`. In CI the spec runs on a fresh DB with one worker and `setFxRates` only upserts the same EUR rate.
- **Deliberate break** (grid column, nowrap wrapper and the 0 % fill all reverted, rebuilt):
  - Vitest → `× Progress figures row > draws no fill at 0 % …` / `Tests  1 failed | 2 passed (3)`;
  - E2E → `Error: .ch-bar right edge` `Expected: <= 693.328125` `Received: 737.4375` (1440) and `Expected: <= 366` `Received: 385.4375` (390) — exactly David's bug.
  - Note: the first version of the E2E used "0.00 POL" and did **not** fail under the break (the smaller type already fits); it now seeds a large indexed raised amount so it can fail.
  - Restored → all green as above.
- Screenshots 1440 / 390 of the list, landing and campaign page checked (temporary spec, not committed).
- Full web suite / full E2E: left to CI.

## Suggested commit message
fix(ui): campaign cards keep bar and figures inside, smaller card type

## Part 2 — converted amounts in whole units (David 2026-10-05: "ok kul, se strinjam s tabo, brez decimalk")
- `lib/fx/display.ts` `formatCurrencyAmount`: when |value| ≥ 1,000 (`WHOLE_UNITS_FROM`, read from the decimal string, no float) the converted figure has 0 decimals, rounded half up by `Intl.NumberFormat` ("≈ 5,495,542 POL", "≈ CHF 11,265"); below 1,000 the currency's decimals stay ("€999.99", "20.28 POL", "0.2200125 BTC"). The exact original in brackets is unchanged.
- Tests: `display-currency.test.ts` (whole units at 1,000 / 1,234,567.89 / negative / 9·10¹³; decimals at 999.99, 20.28, 0.00), `e2e/display-currency.spec.ts` ("≈ CHF 11,265"), `e2e/campaign-card-layout.spec.ts` ("≈ 107,074,405 POL (12,345,678.91 USDC)").
- Real outputs: `vitest run src/__tests__/display-currency.test.ts` → `Tests  9 passed (9)`. **Deliberate break** (`isLarge` bypassed) → `× formatting > converts and formats per currency` `Expected: "CHF 1,234,568"` `Received: "CHF 1,234,567.89"` / `Tests  1 failed | 8 passed (9)`; restored → `9 passed (9)`.
- `pnpm build` + `playwright test display-currency, campaign-card-layout, campaigns, landing, campaign-review --retries=0` → `17 passed`, `1 failed` (display-currency 1440: "Target in euros€12,000" — no CHF rate in the 30 s fx memory because the parallel local workers of the other specs filled it first; CI uses one worker); after `delete from app.fx_rates`, 31 s wait, the spec alone → `2 passed (12.1s)`.
- Screenshot 1440 of cards in POL checked: "≈ 152,654 POL (€15,000)".


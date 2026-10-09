# TASK-060 feedback — goal currency per campaign (ADR-060)
Status: DONE (two PRs: schema #189, code PR after it)

## What I implemented
- **Schema (PR #189, expand step):** migration `0021_goal_currency.sql` — `campaigns.goal_currency` (`EUR`/`USD`, default `EUR`, check), `campaigns.goal_amount_minor` (cents, backfilled from `target_eur_cents`, `NOT NULL`, `> 0`), `target_eur_cents` nullable, trigger `campaigns_goal_sync` that keeps the legacy column in step (EUR goals mirrored, other currencies NULL; old-code inserts/edits that write only `target_eur_cents` fill the goal). Shipped alone so the running code keeps working during the deploy window.
- **Shared:** `GOAL_CURRENCIES` (`EUR`, `USD`), `isGoalCurrency`, `CampaignGoal` + `campaignGoal()`; the draft schema has `goalCurrency` + `goal` (whole units, 100–1,000,000) instead of `targetEur`; `usdCentsToUsdc` (1:1, exact); `rateToNumeric8` (moved from two local copies, see Deviations).
- **Campaign form:** "Goal currency" select (EUR preselected for new drafts) next to "Goal"; the suffix shows the chosen currency. Edit page prefills both.
- **Approval:** a USD goal becomes `target_usdc = cents × 10⁴`, `rate_source = USD_PEG`, `eur_usd_rate` NULL, **no ECB request** (approval works while the ECB is down); EUR unchanged (ECB, floor). The approve response and the audit entry now carry `goalCurrency` and `rateSource`. Admin campaign page shows "Conversion: 1 USD = 1 USDC" for USD goals.
- **Display:** `GoalAmount` (replaces `EurAmount`) on cards, landing, campaign page, admin list + detail, account campaign page; converts from the goal currency into the visitor's display currency ("≈ CHF 9,600 ($12,000)"). Link preview and widget format the goal in its own currency (`formatGoal`).
- **Public API v1:** campaigns gain `goal { currency, amountMinor }`; `target.eurCents` stays for EUR goals and is `null` otherwise (OpenAPI updated, marked deprecated).

## Files changed (main ones)
- `packages/db/drizzle/0021_goal_currency.sql`, `meta/0021_snapshot.json`, `_journal.json`, `packages/db/src/schema/campaigns.ts`
- `packages/shared/src/campaigns.ts`, `packages/shared/src/money.ts` (+ tests)
- `apps/web/src/lib/campaigns/{drafts,review,public,goal}.ts`, `lib/admin/campaigns.ts`, `lib/fx/display.ts`, `lib/api/{v1,openapi}.ts`, `lib/embed/widget.ts`, `lib/demo/create.ts`
- `apps/web/src/components/Amount.tsx`, `components/campaigns/PublicCampaignCard.tsx`, pages: landing, campaign page + `opengraph-image`, admin campaigns list/detail, account campaign new/edit + `CampaignForm.tsx`
- `apps/web/messages/en.json`
- tests: DB integration, shared, web Vitest (drafts, review, display currency + fixtures renamed to `goalAmountMinor`), worker test fixtures, E2E `campaigns.spec.ts`, `display-currency.spec.ts`

## Deviations from the task (and why)
- **The legacy column stays** (nullable, kept in sync by a trigger) instead of being replaced at once: dropping/renaming it in the same deploy would break the old container during "Migrate". A later contract migration drops `target_eur_cents` and the trigger.
- **`rateToNumeric8` moved to `@cherrio/shared`:** with the new branch in `approveCampaign` the minifier inlined the local `rateColumn` arrow, and Next's build-time file tracer (`@vercel/nft`, step "Collecting page data") evaluated `rate / 100000000n` with an unknown `rate` → `next build` failed with `TypeError: Cannot mix BigInt and other types`. Found by capturing the error stack with a `--require` preload (`at Object.BinaryExpression (…/next/dist/compiled/@vercel/nft/index.js)`) and running nft per compiled chunk (failing chunks contained `${a/100000000n}.${(a%100000000n)…}`). A cross-module call is not inlined.
- **Left out on purpose:** demo campaigns stay in EUR (the pool is written in euros); the donate box's quick amounts (€10/€25/…) stay in euros — it is the donor's input currency, not the goal; GBP and other currencies (ADR-060 "later").

## New dependencies
- none

## How to verify
1. `DATABASE_URL=… pnpm --filter @cherrio/db test:integration` → 19 passed (new: "goal currency (ADR-060, migration 0021)").
2. `pnpm --filter @cherrio/shared test` → 109 passed.
3. `DATABASE_URL=… pnpm --filter web test` → 581 passed.
4. `cd apps/web && pnpm build && CI=1 pnpm exec playwright test e2e/campaigns.spec.ts e2e/display-currency.spec.ts --retries=0`.
5. On dev: start a campaign → "Goal currency" → "USD — US dollar", goal 12000 → save → the page shows "Goal: $12,000"; after approval the admin campaign page shows "Conversion: 1 USD = 1 USDC" and "Target in USDC 12,000".

## Test results (real outputs, 2026-10-09)
- Schema PR, running code on the migrated DB without code changes: web Vitest `Test Files 71 passed (71) · Tests 578 passed (578)`; worker `Tests 25 passed (25)`; DB integration `Tests 19 passed (19)`.
- Schema deliberate break (USD no longer clears the legacy column):
  ```
  × goal currency (ADR-060, migration 0021) > keeps goal_currency/goal_amount_minor and the legacy target_eur_cents in step
  -   "target_eur_cents": null,
  +   "target_eur_cents": "300000",
  Tests  1 failed | 18 passed (19)
  ```
  restored → `Tests 19 passed (19)`.
- Code: shared `Tests 109 passed (109)`; web Vitest `Test Files 71 passed (71) · Tests 581 passed (581)`; worker `Tests 25 passed (25)`; lint + typecheck clean; `pnpm check:design` "Design check passed — no violations found."; `pnpm build` passes (after the nft fix above).
- E2E: `e2e/campaigns.spec.ts` `8 passed (25.4s)` (creates the draft with a USD goal, checks "Goal: … $12,000" in review); `e2e/display-currency.spec.ts` `2 passed (12.8s)`.
- Deliberate break 1 (approval ignores the USD branch):
  ```
  × campaign review … > approve a USD goal (ADR-060): 1 USD = 1 USDC, no ECB request, rate source USD_PEG
  Tests  1 failed | 9 passed (10)
  ```
- Deliberate break 2 (`goalAsUsdc` converts every goal as EUR):
  ```
  × formatting > goals (ADR-060): shown in their own currency, converted from it into a third one
  AssertionError: expected 13470000000n to be 12000000000n // Object.is equality
  Tests  1 failed | 9 passed (10)
  ```
  both restored with the reverse `sed`; files pass again.
- Screenshots of the form at 1440 and 390 px checked (currency select and goal side by side on desktop, stacked on a phone; not committed).

## docs/technical chapters updated
- `01-system-overview.md` (review step, data table, glossary), `03-data-and-indexer.md` (`campaigns` columns, trigger, approval for USD), `04-web-app-and-auth.md` (`GoalAmount`), `09-status-and-roadmap.md` (TASK-060 row; TASK-019/020 rows and the stale backlog rows cleaned up); guides `fundraisers.md`, `donors.md`; `01-PRODUCT-SPEC.md` field list; `docs/whitepaper/CORRECTIONS.md` #13.

## Part b (2026-10-09, David: "ok uredi")
- **Donate panel in the goal currency:** `donationInputMode(goalCurrency, rate)` — a USD campaign's field is in dollars (`$10/$25/$50/$100`, hint "Paid in USDC, a digital dollar: $1 = 1 USDC.", minimum "$1", no ECB line in Details, works without an EUR rate); EUR campaigns unchanged. Quick-amount labels formatted with `Intl.NumberFormat` (message `quick` removed).
- **Contract step 1:** `targetEurCents` removed from the Drizzle schema, so no running code selects `target_eur_cents` any more; migration `0022` (drop column + trigger + function) follows in its own PR after this one is deployed.
- Tests: `donate-amount.test.ts` 21 → 25 (USD mode); web Vitest 583 passed; worker 25 passed; typecheck clean; new E2E "a USD campaign (ADR-060): amounts in dollars, 1 USD = 1 USDC, no EUR rate" — `e2e/donate.spec.ts` `10 passed (35.8s)`; `pnpm build` passes.
- Deliberate break (`donationInputMode` ignores USD): `AssertionError: expected 'USDC' to be 'USD'` · `Tests 1 failed | 24 passed (25)`; restored → `Tests 25 passed (25)`.

## Open questions / risks
- Contract step (later, small PR): drop `target_eur_cents` and `campaigns_goal_sync` once no running code reads the column.

## Suggested commit message
feat(web): goal currency per campaign — EUR or USD (TASK-060, ADR-060)

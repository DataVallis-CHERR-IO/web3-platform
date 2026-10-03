# TASK-031 feedback
Status: DONE (Built; Live on dev after the deploy)

## What I implemented
- ADR-040 (display currency), from David's answers of 2026-10-03.
- **Currencies.** `@cherrio/shared/display-currency`:
  - 30 fiat (EUR + ECB) and 4 crypto (USDC, BTC, ETH, POL), with their shown decimals;
  - default from the browser languages: region first, then language, then USD;
  - `Accept-Language` parsing;
  - `bigint` conversion and half-up rounding;
  - exact decimal parsing, exponents included.
- **Rates in `app.fx_rates`** (migration `0006`):
  - ECB: all currencies, as USD per unit;
  - CoinGecko keyless `simple/price`: prices parsed from the JSON text, with sanity bands; optional `COINGECKO_DEMO_API_KEY`;
  - lazy refresh after the response via `after()` (ECB 1 h, CoinGecko 5 min). On first use the request waits;
  - 60 s retry pause after a failure, and old values are kept;
  - staleness cut-offs: fiat ECB date older than 7 days, crypto fetched more than 1 h ago.
- **Header selector** (desktop, and the mobile menu, which closes after a choice), accessible name "Currency".
  - `PUT /api/preferences/currency` sets the cookie `cherrio_currency`, and the profile when logged in.
  - Login restores the profile choice into the cookie.
- **`UsdcAmount` / `EurAmount`** show "≈ CHF 11,264.64 (€12,000)". Used on:
  - the admin campaign list (target);
  - the admin campaign detail (target, snapshot target);
  - the organisation's campaign page.
- Footer credit for ECB and CoinGecko.
- Docs:
  - technical 01, 03, 04 (new §2a), 05, 06, 07, 08 (§5.1d), 09;
  - `guides/donors.md` ("Amounts in your currency");
  - `tasks/README.md`, spec.

## Files changed
- `docs/03-DECISIONS.md` (ADR-040), `docs/tasks/TASK-031-display-currency.md`
- `packages/shared/src/display-currency.ts`, `index.ts`, `package.json`, `test/display-currency.test.ts`
- `packages/db/src/schema/{fx,users,index}.ts`, `packages/db/drizzle/0006_polite_hobgoblin.sql`, `meta/*`, `src/__tests__/integration.test.ts` (20 tables)
- `apps/web/src/lib/fx/{sources,rates,display,cookie}.ts`
- `apps/web/src/components/{Amount,CurrencySelect,AppHeader,AppFooter}.tsx`
- `apps/web/src/app/api/preferences/currency/route.ts`, `apps/web/src/app/api/auth/session/route.ts` (cookie at login)
- `apps/web/src/lib/security/rate-limit.ts` (preferences limiter, 30/min per IP)
- `apps/web/src/app/[locale]/admin/campaigns/page.tsx`, `admin/campaigns/[id]/page.tsx`, `account/campaigns/[id]/page.tsx`
- `apps/web/messages/en.json` (`fx.*`, footer credit; `campaigns…target` is now the label "Target")
- `apps/web/src/__tests__/display-currency.test.ts`, `apps/web/e2e/display-currency.spec.ts`, `apps/web/e2e/helpers/session.ts` (`setFxRates`)
- `apps/web/playwright.config.ts` (`COINGECKO_URL` → a closed local port)
- docs listed above

## Deviations from the task (and why)
- **No cross-container advisory lock for refreshes.** The spec named `pg_try_advisory_lock`. It would hold a DB connection during an HTTP call. Instead, within a container one request fetches a source at a time with a 60 s retry pause, and rows are upserted, so two containers fetching at once is harmless. The spec is updated.
- **E2E writes rates into the table** instead of serving fixtures; it is deterministic and no network is involved. The spec is updated.
- **An empty `fx_rates` read is not cached in memory**, so a page shows conversions as soon as rates exist.

## New dependencies
- none

## How to verify
1. `export DATABASE_URL=postgres://cherrio:cherrio@127.0.0.1:5432/cherrio_dev`
2. `pnpm --filter @cherrio/shared test`, `pnpm --filter web test`, `cd apps/web && CI=1 pnpm exec playwright test --retries=0`
3. On dev after the deploy:
   - open any admin campaign: the header shows a currency chosen from your browser;
   - choose CHF: the target shows "≈ CHF … (€…)";
   - choose EUR: only the euro amount shows;
   - reload: the choice stays.
   - On the first page load the server fetches the rates once, so the first view may take a moment.

## Test results (this session, 2026-10-03)
- typecheck and lint (web, shared): pass. `check:design` (apps/web): "Design check passed — no violations found."
- `@cherrio/shared`: Tests 99 passed (99); `display-currency.test.ts` 16 passed.
- `web`: Test Files 25 passed (25), Tests 161 passed (161); `display-currency.test.ts` 9 passed.
- E2E (full suite, after a fresh build): `114 passed (2.7m)`.
  - `display-currency.spec.ts`: 2 passed (1440 and 390 viewports).
  - The log shows `[fx] COINGECKO refresh failed: exchange-rate source unavailable: request failed`. This is expected: tests point CoinGecko at a closed port.
- Deliberate breaks:
  - **Rounding truncates instead of half-up:** `conversion and rounding` failed twice (`expected '0.00863461' to be '0.00863462'`, `expected '1.00' to be '1.01'`), giving `Tests 2 failed | 14 passed (16)`. Restored: `16 passed`.
  - **Crypto never stale:** `stale rates are not shown …` failed with `expected { …(3) } to be undefined`, giving `Tests 1 failed | 8 passed (9)`. Restored: `9 passed`.
- `@cherrio/db` integration: Tests 16 passed (16).
  - The guard test "creates schema `app` with all N tables" first failed (`expected [ Array(20) ] to deeply equal [ Array(19) ]`) because of the new table. Its list now includes `fx_rates`.
- Contracts and indexer suites: not run locally (no Foundry here). CI runs the indexer scenario because `packages/shared` and `packages/db` changed.

## Open questions / risks
- **CoinGecko keyless limits** (about 10–30 calls/min) are far above our use (at most every 5 min per container). If it refuses, a free Demo key can be set. That is David's account decision.
- **Rates are display only and approximate.** The exact original is always shown, and no stored or on-chain amount depends on them.
- **The header selector renders after hydration**, because the cookie and the browser languages are read in the browser. Before that the trigger shows "Currency".

## Suggested commit message
feat(fx): display currency — amounts in any ECB fiat currency or BTC/ETH/POL/USDC (TASK-031, ADR-040)

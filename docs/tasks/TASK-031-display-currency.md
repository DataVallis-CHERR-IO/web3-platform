# TASK-031 — Display currency: show amounts in any fiat or crypto currency (ADR-040)

Branch: `feat/TASK-031-display-currency` (from `dev`). Depends on: TASK-010 (ECB module, amounts), TASK-025 (session).
Decisions: ADR-040 (David, 2026-10-03: "ECB fiat + major crypto", "CoinGecko free API", "default by browser language/region"). Model: standard.

## Goal
CHERR.IO is global. A visitor chooses a currency, and amounts are shown in it. The available currencies are:
- **Fiat:** EUR plus every currency of the ECB daily reference rates (about 30);
- **Crypto:** BTC, ETH, POL, USDC.

The record does not change. On-chain, in the database and in all money logic, amounts stay USDC (`bigint`, 6 decimals) and EUR targets (ADR-036). Conversion is for display only.

## Rules
- A converted amount is marked **"≈"** and the **exact original** stays visible (smaller, next to it). When the chosen currency is the original one (EUR for a EUR target, USDC for a USDC amount), no "≈" and no second value.
- Rates (all relative to USD, with 1 USDC = 1 USD as in ADR-036):
  - **Fiat:** from the ECB daily file. `USD per X = (USD per EUR) ÷ (X per EUR)`; for EUR it is `USD per EUR`. The rate date is the ECB date.
  - **Crypto:** from the CoinGecko free API (keyless): `GET https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,polygon-ecosystem-token&vs_currencies=usd&include_last_updated_at=true`. An optional `COINGECKO_DEMO_API_KEY` is sent as `x-cg-demo-api-key` when set. USDC = 1 USD by definition (no fetch).
- **Storage:** `app.fx_rates` holds `currency` (PK), `usd_per_unit` (numeric(38,18)), `source` (`ECB` | `COINGECKO`), `rate_at` and `fetched_at`. It is shared by all containers, and the last good value survives an outage.
- **Refresh:** only the server fetches, lazily, when a page needs rates.
  - ECB: when the last fetch is older than 1 hour. CoinGecko: when it is older than 5 minutes.
  - The refresh runs after the response (`after()` in Next.js), so pages do not wait. Within a container a source is fetched by one request at a time, and after a failure it is retried no sooner than 60 s later. Rows are upserted, so two containers fetching at once is harmless.
  - Failures are logged, and old values are kept.
  - First run: when the table is empty, the request waits up to 5 s.
- **Staleness:** a fiat rate whose ECB date is older than 7 days, or a crypto price fetched more than 1 hour ago, is **not used**. The original amount is shown alone.
- **Rounding (display only):** half-up, done in `bigint`, at the currency's display decimals:
  - fiat: ISO minor units (JPY, KRW, ISK, IDR, HUF → 0 in display; others 2);
  - BTC 8, ETH 6, POL 2, USDC 2.
- **Default currency:** from the browser language and region.
  - The server uses `Accept-Language`; the selector uses `navigator.languages`; both call the same shared function.
  - The region decides (e.g. `sl-SI` → EUR, `en-GB` → GBP, `de-CH` → CHF). A language without a region uses a small language map (e.g. `sl` → EUR, `ja` → JPY).
  - Unknown → USD.
- **Choice:**
  - kept in the cookie `cherrio_currency` (1 year, `SameSite=Lax`, not secret, readable by the page);
  - for a logged-in user also in `users.display_currency`;
  - at login, a stored profile choice is written to the cookie.
  - Resolution on the server: valid cookie → `Accept-Language` → USD.
- **Credit:** the footer says where rates come from: "Exchange rates: ECB reference rates; crypto prices by CoinGecko".

## Scope

### Data (backward-compatible migration 0006)
- New table `fx_rates` (see above).
- `users.display_currency` varchar(10), nullable.

### Shared (`@cherrio/shared`, `display-currency.ts`)
- `DISPLAY_CURRENCIES`: code, kind (`fiat` / `crypto`), display decimals.
- `isDisplayCurrency(code)`.
- `currencyForLanguages(list)`: region map, then language map, then USD.
- `parseLanguageHeader(header)` → ordered tags.
- `convertUsdc(usdc, usdPerUnit18)` → value in the currency's units scaled ×10¹⁸ (`usdc × 10³⁰ ÷ usdPerUnit18`).
- `roundScaled(value18, decimals)` → decimal string, half-up.
- Unit tests for each, including rounding edges and JPY/BTC.

### Web
- `lib/fx/ecb-rates.ts`: parse every currency of the ECB file (the existing USD parser stays for ADR-036).
- `lib/fx/coingecko.ts`: fetch and parse, with a timeout, sanity bands and exact decimal parsing (no float in stored rates).
- `lib/fx/rates.ts`: `getDisplayRates(db)` — read the table, refresh lazily, apply the staleness rules.
- `lib/fx/display.ts`: `resolveDisplayCurrency()` (cookie, then header) and `formatDisplay(amount, currency)` via `Intl.NumberFormat` (decimal string input).
- `components/Amount.tsx` (server):
  - `<UsdcAmount usdc />` and `<EurAmount eurCents />`: "≈ CHF 1,234.56" plus the original;
  - EUR targets are converted through USD with the current ECB rate (display only; the campaign's own approval snapshot is still shown where it already is).
- `components/CurrencySelect.tsx` (client):
  - a labelled native `<select>` with groups Fiat / Crypto, in the header (desktop and mobile menu);
  - on change: `PUT /api/preferences/currency`, then refresh.
- `PUT /api/preferences/currency`:
  - origin check, 30/min per IP, body `{ currency }` (must be a display currency, else 400);
  - sets the cookie, and the profile when a session exists.
- Login (`POST /api/auth/session`): if the profile has a currency, set the cookie in the response.
- Use the new components where amounts are shown today:
  - the admin campaign list (target);
  - the admin campaign detail (target in EUR; target USDC in the snapshot);
  - the organisation's campaign view (target).
- Footer credit line. All text via next-intl.

## Tests
- shared unit tests (conversion, rounding, language → currency);
- ECB-all and CoinGecko parsers against fixtures, including broken answers;
- `getDisplayRates` against Postgres: lazy refresh with fake fetchers, the staleness cut-off, and a failure that keeps old values;
- the preferences route (cookie, profile, invalid code 400, origin);
- E2E: choose CHF in the header → an admin page shows "≈ CHF …" plus the original; reload keeps it; axe; the default from `Accept-Language` `de-CH` is CHF. E2E writes the rates into `app.fx_rates` with a fresh `fetched_at`, so nothing is fetched; `COINGECKO_URL` (honoured only when `APP_ENV=local`) points to a closed local port, so CoinGecko is never called from tests.
- Deliberate breaks: the rounding direction and the staleness check.

## Not in scope
- Public campaign pages (TASK-011 uses these components).
- Donating in another currency (donations stay USDC; card onramp is TASK-012).
- Historical rates for past donations.

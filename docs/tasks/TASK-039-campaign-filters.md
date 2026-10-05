# TASK-039 — Cause and country filters on the campaign list

Source: HANDOFF "Next" #1 (David wants to test filters with the demo data, 2026-10-05; the landing's old filter buttons were stubs and were removed in TASK-037). Ad-hoc task started by the cloud session on David's "začni z razvojem" (2026-10-05).

## Scope
- `listPublicCampaigns` takes optional `cause` and `country` filters; `total` and `pageCount` count the filtered campaigns; the fallback query without the indexer views filters too.
- `parseCampaignFilters(query)`: reads `?cause=` / `?country=` from the URL; unknown causes (not in `ORGANIZATION_CAUSES`) and countries (not in `COUNTRY_CODES`) are dropped — the list shows everything instead of an error.
- `listCampaignFacets(db, filters)`: causes that have published campaigns (counted within the chosen country) and countries that have published campaigns (counted within the chosen cause). Causes keep the fixed cause-list order.
- `/en/campaigns`: a "Filter campaigns" section — cause chips as links ("All causes" + each cause with its count; the chosen one has `aria-current`), a country `<select>` in a plain GET form with a "Show" button (works without JavaScript and keeps the cause), the result count and "Clear filters". A filter with no campaigns shows "No campaigns match these filters." with "Show all campaigns". The pager keeps the filters.
- Design-system tokens only (new `.ch-filter*` classes in `packages/ui/src/styles/components.css`).

## Not in scope
Sorting (ending soon / most raised) and text search — possible follow-ups. Filters on the landing page. An index on `campaigns(status, cause, country)` — only if `/campaigns` gets slow.

## Tests
DB-backed Vitest (filtered list and totals, facets, URL parsing incl. unknown values), a stub test that the fallback query keeps the filter, one E2E on two viewports (chips, form, empty state, unknown values, axe). Deliberate breaks: accept any cause; drop the filter in the fallback query; drop the hidden cause field in the country form.

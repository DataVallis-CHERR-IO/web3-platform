# TASK-054 feedback — accent-insensitive search
Status: DONE

David 2026-10-07: "potem pa nadaljuj z razvojem" — the session picked the open item left by TASK-053 ("accent-insensitive search (`unaccent` + migration)"). No separate spec; this file is the record.

## What I implemented
- Migration `packages/db/drizzle/0015_unaccent.sql`: `CREATE EXTENSION IF NOT EXISTS "unaccent" WITH SCHEMA public`. `unaccent` ships with Postgres (contrib, included in the `pgvector/pgvector:pg16` image) and is a trusted extension since Postgres 13, so the database owner may create it — on the server the web role `cherrio_<env>` owns its database (`infra/shared/ensure-databases.sh`) and runs the migrations.
- `containsText(column, text)` in `apps/web/src/lib/admin/listing.ts`: `public.unaccent(column) ilike public.unaccent(pattern)` with the existing literal pattern (`%` and `_` escaped). Case- and accent-insensitive in both directions: "sola" finds "Šola", "cafe" finds "Café", "cafè" finds "Café".
- Used by every text search: public `/campaigns` (`lib/campaigns/public.ts`, title + organisation name), Admin → Campaigns (`lib/admin/campaigns.ts`) and Admin → Organisations (`lib/admin/organizations.ts`, name, legal name, register number).

## Files changed
- `packages/db/drizzle/0015_unaccent.sql`, `packages/db/drizzle/meta/_journal.json`, `packages/db/drizzle/meta/0015_snapshot.json` (drizzle-kit `generate --custom`; snapshot unchanged from 0014).
- `apps/web/src/lib/admin/listing.ts` — `containsText`.
- `apps/web/src/lib/campaigns/public.ts`, `apps/web/src/lib/admin/campaigns.ts`, `apps/web/src/lib/admin/organizations.ts` — use it.
- `apps/web/src/__tests__/public-campaigns.test.ts` — new test "search ignores accents both ways".
- `apps/web/src/__tests__/admin-overview.test.ts` — accent cases for organisations and campaigns.
- Docs: `docs/technical/03-data-and-indexer.md` (migration list), `04-web-app-and-auth.md` (public list + admin lists), `09-status-and-roadmap.md`, `docs/tasks/README.md`.

## Deviations
- none from the TASK-053 note. Left out on purpose ("ne več dela kot koristi"): an unaccented generated column with a trigram index (`pg_trgm`) — the search is a per-row scan as before; worth it only far beyond 10,000 campaigns. No change to the filter-group search box (already accent-insensitive in the browser since TASK-042).

## Deploy note
Migrations run after the web deploy (CHEATSHEET, `03` §migrations). Between the new container starting and `migrate` finishing (up to a minute) a search request would fail with "function public.unaccent does not exist"; pages without a search are not affected. Same short window as migration `0014` with PR #134.

## New dependencies
- none (Postgres contrib extension `unaccent`)

## How to verify
1. `pnpm --filter @cherrio/db migrate` → "Migrations complete."
2. `DATABASE_URL=… pnpm --filter web test` → 520 passed.
3. On dev after the deploy: https://dev.cherr.io/en/campaigns → search a title word without its accents (e.g. a title with "č", "š" or "ž", typed with "c", "s", "z") → the campaign is listed.

## Test results
Affected files:
```
 Test Files  2 passed (2)
      Tests  28 passed (28)
```
Deliberate break — `containsText` back to a plain `ilike` without `unaccent`:
```
   × public campaign read model (Postgres) > search ignores accents both ways (TASK-054) 25ms
     → expected [] to deeply equal [ Array(1) ]
   × admin overview lists (Postgres) > organisations: filters by KYB status, source and country; search is literal (% and _ are not wildcards) 37ms
     → expected [] to deeply equal [ 'ovwmuyfknya Shelter 08' ]
   × admin overview lists (Postgres) > campaigns: each view shows its status in its order; search by title or organisation; counts per view 24ms
     → expected [] to deeply equal [ '5' ]
      Tests  3 failed | 25 passed (28)
```
Restored → all passed. Full web suite:
```
 Test Files  60 passed (60)
      Tests  520 passed (520)
```
DB integration: `Tests  18 passed (18)` (then `migrate` again).

Speed (`pnpm --filter web perf:campaigns`, 10,000 campaigns, local Postgres, two runs each):
```
plain ilike : /campaigns search 32 / 37 ms · facets (search) 28.6 / 27.8 ms · admin campaigns search 14.9 / 15 ms
unaccent    : /campaigns search 54.6 / 50.1 ms · facets (search) 47.1 / 47.4 ms · admin campaigns search 23.7 / 24.8 ms
```
All within the budgets (150 / 100 / 150 ms). The first run after migrating showed facets 72.5 ms (cold cache).

## Open questions / risks
- Beyond ~30,000 campaigns the facets within a search would approach their 100 ms budget; the trigram index above is the next step then.

## Suggested commit message
feat(search): accent-insensitive campaign and organisation search (unaccent)

## After the merge
PR #153 merged 2026-10-07 (E2E shard 1 hung in "Install Playwright Chromium" once — run cancelled and failed jobs re-run → green). Deploy 37669149090 green; "Build → Deploy → Migrate" applied `0015_unaccent`.

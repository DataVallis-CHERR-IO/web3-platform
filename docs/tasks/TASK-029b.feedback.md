# TASK-029b feedback — admin overview of organisations and campaigns (§3)
Status: DONE (in code) — green locally; CI results are in the PR. Labels are **Built** until David checks on dev.

## Steps for David (after the deploy)
1. `/en/admin` (your name → Admin) → **All organisations**.
   - Tabs: All, Waiting for review, Verified, Not accepted, Not verified, each with its count.
   - Type in **Search**; the list updates after a short pause and the address bar keeps the filter, so you can bookmark or share it.
   - Try the Source and Country filters.
   - Click an organisation → data, members, verification applications, campaigns.
2. `/en/admin` → **Campaigns: review and publish** → tabs Waiting for review, Approved — waiting to be published, Live, Not accepted, Drafts, All. "Lorem ipsum" must be under **Live**.
3. 50 rows per page; "Next page" appears only when there are more.

## What I implemented
- **`lib/admin/listing.ts`** — shared list mechanics:
  - URL parameters: `q`, filters, `after`;
  - an ILIKE-escaped search;
  - an opaque keyset cursor (base64url of `[sortKey, id]`), validated, so a broken cursor shows the first page;
  - `listHref` builds links that keep the filters and reset the page.
- **Keyset pagination done right:**
  - The cursor's sort key is the timestamp as UTC text with **microseconds**, taken from Postgres (`to_char … US`). A JS Date has only milliseconds, so rows within one millisecond would be skipped or repeated.
  - The row id is the tie-breaker: `(sort, id) > / < (cursor)`.
  - Proven with 60 organisations inserted in one statement (identical `created_at`) and 55 campaigns where many share a timestamp.
- **`lib/admin/organizations.ts`:** `listOrganizations` filters by KYB status, source and country; search covers name, legal name and register number (case-insensitive, literal); campaign count via a grouped subquery; newest first. `organizationCounts` gives the tab counts.
- **`lib/admin/campaigns.ts`:** `listCampaigns` with views. Each view has its status and order:
  - review: submitted, oldest first;
  - publish: approved, oldest first;
  - live: published, newest first;
  - rejected: newest first;
  - drafts: last change, newest first;
  - all: created, newest first.

  Search by title or organisation name; country filter. `campaignCounts` gives the tab counts.
- **`components/admin/ListFilters.tsx`** (client): search (debounced 300 ms), selects and a searchable country select. It writes to the URL with `router.replace` (no scroll jump) and returns to page 1 on every change.
- **Pages:**
  - `/en/admin/organizations` (tabs, filters, table, pages);
  - `/en/admin/organizations/[id]` (data, members, applications, campaigns);
  - `/en/admin/campaigns` rebuilt as tabs. The previous two lists are now the first two tabs.
  - Campaign detail: drafts are now visible to admins (read-only), and the organisation name links to its page.
  - Admin home: a fifth tile (verified organisations); tiles link to the matching tab; an "All organisations" button.

## Files changed
- New: `apps/web/src/lib/admin/listing.ts`, `organizations.ts`, `campaigns.ts`; `src/components/admin/ListFilters.tsx`; `src/app/[locale]/admin/organizations/page.tsx`, `[id]/page.tsx`; `src/__tests__/admin-overview.test.ts`; `e2e/admin-overview.spec.ts`
- Changed: `src/app/[locale]/admin/campaigns/page.tsx` (tabs), `admin/campaigns/[id]/page.tsx` (drafts, organisation link, back link), `admin/page.tsx` (tile, links), `messages/en.json` (`admin.list.*`, `admin.organizations.*`, `admin.campaigns.views/viewsEmpty/viewDate/…`; seven unused keys removed), `e2e/campaign-review.spec.ts` (approved list is now a tab)
- Docs: `docs/technical/04`, `07`, `09`; `docs/tasks/README.md`, `TASK-029-ux-fixes-admin-overview.md`

## Deviations
- **No "previous page" button.** Keyset pages go forward, and "First page" returns to the start. Going back works with the browser's back button, because every page is a URL.
- **No new database indexes.** The existing `campaigns_status_idx` covers the tabs. Organisations are filtered on columns without an index; at the current size (tens of rows, later the ~30k imported registry rows) this is fine. Add `organizations(kyb_status, created_at)` and a trigram index on `name` when the registry import (TASK-016) lands.
- **Admins see drafts.** Before, a never-submitted draft was a 404 for admins; the overview needs to open it.

## New dependencies
- none

## Test results (all from this session; same sandbox substitutes as before)
- `web`: `Test Files 23 passed (23)`, `Tests 146 passed (146)`. New: `admin-overview.test.ts`, 5 tests on Postgres:
  - 50 + 10 organisations with identical timestamps, every row exactly once, stable order;
  - KYB, source and country filters; search is case-insensitive and treats `%` and `_` literally;
  - each campaign view returns its status in its order; search by organisation name; counts;
  - the ascending review queue paged over 55 rows with shared timestamps;
  - a broken cursor or one with SQL in it means the first page.
- `@cherrio/shared`: `Tests 60 passed (60)`.
- E2E, whole suite: `110 passed (2.3m)`. New `admin-overview.spec.ts` (2 tests × 2 viewports):
  - 404 for non-admins;
  - search writes `?q=` and finds the organisation; tabs keep the search; the URL survives a reload; organisation detail → campaign;
  - campaign "All" tab with a search by organisation; empty "Live" tab;
  - axe on every page.
- Lint, typecheck, design check: clean.
- **Deliberate break** (keyset without the id tie-breaker): `Tests 2 failed | 3 passed (5)` — `expected [] to have a length of 10 but got +0` and `… of 5 …` (the second page lost every row that shared the cursor's timestamp). Restored → 5 passed.

## NOT RUN
- Behaviour with ~30k organisations (no such data locally); see "Deviations" for the indexes to add with the registry import.
- docker build: CI.

## Suggested commit message
feat(web): admin overview of all organisations and campaigns with search, filters and keyset pages (TASK-029 §3)

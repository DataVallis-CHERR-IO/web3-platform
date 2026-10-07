# TASK-053 — Search and sort on the public campaign list

Status: Live on dev (PR #145, Deploy 37634879899) · Owner decision: none needed (HANDOFF Next 2 "possible follow-ups on `/campaigns`"; David 2026-10-07: "nadaljuj")

## Goal
A donor who knows what they look for (a school, a town, an organisation) finds it without paging; a donor who wants to see momentum can sort by money raised or by newest.

## Scope
- `?q=` — text search over the campaign title and the organisation name; case-insensitive ILIKE, `%` and `_` literal; trimmed, spaces collapsed, at most 100 characters.
- `?sort=` — `ending` (default, the existing order), `newest` (publish time, `coalesce(deployed_at, created_at)`), `raised` (`chain.campaign.total_raised`). **Every order keeps live campaigns first**, so a donor never pages past ended campaigns to give. Unknown values → default.
- Facet counts, the total and the pager respect the search.
- UI: above the results a GET form "Search campaigns" + "Search" button and a native select "Sort by" (`components/campaigns/CampaignListControls.tsx`). Without JavaScript the form submits (chosen causes/countries as hidden fields); with JavaScript the select and Enter replace the URL in place. The filter sidebar keeps search and sort; the search shows as a removable tag; "Clear all" keeps the order.
- Fallback without the chain views: `newest` by publish time, the rest by deadline (as before).
- Tests: Vitest (order of each sort, search incl. `%`/`_`, facets, URL parsing, `listQuery`), E2E `campaign-search-sort.spec.ts` (both viewports, axe), perf cases at 10,000 campaigns.

## Out of scope (on purpose)
- Accent-insensitive search (needs the `unaccent` extension and a migration; ILIKE covers case only). Revisit if non-English titles grow.
- Full-text ranking / typo tolerance (pgvector RAG is out of scope per the manifest §7).
- Search over the story text (long; would need an index to stay fast).
- Remembering the sort per user.

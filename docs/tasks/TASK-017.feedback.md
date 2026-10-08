# TASK-017 feedback — Trust Score v1 and Charity Market Cap
Spec: `docs/tasks/TASK-017-market-cap.md`; rules ADR-059.

## 017-schema (PR #174)
Status: DONE — Live on dev. Migration `0019`: `trust_scores` listing columns, unique `(org_id, version)`, partial ranking indexes; `pg_trgm` + trigram index on `organizations.name`. US registry import switched on for dev (David "ok nadaljuj").

## 017a — Trust Score worker
Status: DONE — Live on dev (PR #175, Deploy 37785751298)

### What I implemented
- `apps/worker/src/trust.ts`: `computeTrustScores(db, scope)` — two set-based statements (organisations on CHERR.IO from ratings, chain outcomes, vote rounds, evidence bundles and raised totals; imported organisations from registry completeness), each upserting only changed rows and returning just a count.
- Worker schedule: everything at start, nightly after 03:00 UTC and after each registry import; organisations on CHERR.IO every 10 minutes; not while a registry import runs.

### Deviations
- "On time" for evidence is not checked in v1 (ADR-059).
- Applicants with source `REGISTERED` but no approval get a row with `listed = false` (so a later approval only flips fields).

### Test results
`apps/worker/test/trust.test.ts` (4 new: full registered score from ratings/outcomes/rounds/evidence/raised; priors 61.00, pending and demo not listed; imported 40.00 / removed 20.00 not listed / US 28.00; only changed rows rewritten and a new rating moves the score): worker suite `Test Files 3 passed (3)`, `Tests 24 passed (24)`.
Deliberate break — `DRAFT` evidence counted as submitted:
```
   × Trust Score v1 (ADR-059) > scores an organisation on CHERR.IO from ratings, outcomes, votes and evidence 33ms
     → expected 83.52 to be close to 78.52380952380952, received difference is 4.996190476190478, but expected 0.05
```
restored → passing.
Speed (local, synthetic registries: 173,335 UK + 735,122 US imported organisations; bundled runner, 128 MB heap):
```
all {"scope":"all","written":908465} 116067 ms peak rss 58 MB
all {"scope":"all","written":0} 25005 ms peak rss 59 MB
registered {"scope":"registered","written":0} 111 ms peak rss 59 MB
```
A first version returned one row per written score to the client (peak RSS 164 MB at 908k rows); it now returns only a count. `trust_scores` with indexes: ~570 MB at that size.

## 017b — public list and methodology
Status: DONE (Built; PR pending). The organisation profile with "Claim this organization" and JSON-LD follows as 017c.

### What I implemented
- `/en/charity-market-cap`: ranked table (#, organisation, country, causes, Trust Score, raised on CHERR.IO, On / Not on CHERR.IO); search by name (trigram), order by score / raised / name, filters country, cause and on / not on CHERR.IO — only countries and causes that have listed organisations, with counts; state in the URL; keyset pages ("Next 25", "Back to the top"); data sources with the OGL v3.0 attribution (UK) and the IRS BMF line (US). On phones the table keeps #, name, score and status.
- `/en/charity-market-cap/methodology`: the v1 method from the same shared constants the worker uses (`packages/shared/src/trust.ts`: version, weights, completeness checks).
- Landing teaser shows the real top 5 (or the old empty note) and links "How the score works" to the methodology.
- Migration `0020`: the 0019 ranking indexes mixed directions (`score DESC, org_id ASC`), which a keyset row comparison cannot use — replaced by one-direction indexes read backwards (score, country + score, registered + score, raised) and `organizations (name, id)` for the name order.
- `lib/market-cap/list.ts`: a filter that keeps fewer than 20,000 organisations (small country, rare cause, the few on CHERR.IO) is applied first from its own index and the rest sorted; otherwise the order index is walked. Counts per country/cause and of organisations on CHERR.IO are cached for 10 minutes and refreshed in the background.
- `ListFilters` (admin) takes a message namespace so the public list reuses it.

### Deviations
- "#" is the position in the current list: with a filter or search it is not the overall rank (the page says so). A global rank per row would cost a count over up to 1 M rows per row.
- No total count of results (a count over 1 M rows on every request); pages are "next" and "back to the top".

### Test results
`apps/web/src/__tests__/market-cap.test.ts` — 7 tests (order with ties stable across 2-row pages, unlisted rows and other versions skipped; raised and name order; filters under both plans — walking the order index and narrowing first; search with literal `%`/`_`; facet counts; URL parsing and forged cursors): `Tests 7 passed (7)`.
Deliberate break — keyset `(score, org_id) <= (…)` instead of `<`:
```
   × Charity Market Cap list > ranks by score (ties by id, stable across pages), skips unlisted rows and other versions 23ms
      Tests  1 failed | 5 passed (6)
```
restored → passing. Web suite: see the PR run. E2E (local, `CI=1`): `market-cap.spec.ts` (2), landing, auth-nav and the a11y/screenshot runs for the two new pages: `32 passed (1.1m)`.
Speed (local, 1,000,022 organisations with scores, 980,221 listed, 2,007 on CHERR.IO; times per page of 25):
```
facets (cold) 1000.3 ms        facets (cached) 2.02 ms
score                                first 7.7 ms, max 14.0 ms, 200 page(s)
raised                               first 2.0 ms, max 4.4 ms, 50 page(s)
name                                 first 2.0 ms, max 10.0 ms, 50 page(s)
country US                           first 2.8 ms, max 5.8 ms, 50 page(s)
country NZ (3 orgs), by name         first 2.4 ms
cause humanitarian (3), by name      first 3.2 ms
on CHERR.IO (2,000), by name         first 13.8 ms, max 25.5 ms, 50 page(s)
on CHERR.IO, by raised               first 14.4 ms, max 41.8 ms, 50 page(s)
GB + animals                         first 1.9 ms, max 2.0 ms, 20 page(s)
search 'abc1'                        first 16.1 ms
search no match                      first 2.2 ms
```
Before the rare-filter path a cause with 3 organisations took 1,815 ms (the planner walked the whole ranking index).

## Suggested commit messages
feat(worker): Trust Score v1 for every organisation (TASK-017a)
feat(web): Charity Market Cap list and methodology (TASK-017b)

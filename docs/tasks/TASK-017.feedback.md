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
Status: DONE — Live on dev (PR #176, Deploy 37791767260).

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

## 017c — organisation profile and claim
Status: DONE — Live on dev (PR #177, Deploy 37796938978)

### What I implemented
- `/en/charity-market-cap/<org id>` (`lib/market-cap/profile.ts`): name, On / Not on CHERR.IO, country, causes, average rating; about + website; for organisations on CHERR.IO the raised total and their published campaigns (`listPublicCampaigns` got an `orgId` filter); "From the register" — UK: number, status, registration/removal dates, latest financial year end, income, expenditure, link to the Commission's page; US: EIN, city/state, exempt since, latest return, revenue, assets; the `TrustScore` panel (score, version, methodology link; the five weighted parts for organisations on CHERR.IO); for imported ones "What the public record shows" (the five checks, ✓/✕ with a text alternative) and the at-most-40 note; last computed time; OGL v3.0 / IRS source line. 404 when the organisation is not listed (in review, rejected, demo, removed, no score yet).
- JSON-LD `Organization` (name, URL, website as `sameAs`, description, country) with `AggregateRating` when there are ratings; `<` escaped.
- "Claim this organization" for an unclaimed imported organisation (`source IMPORTED`, `kyb_status NONE`, nobody claimed): with a session a link to `/en/organizations/new?claim=<id>`, otherwise "Log in to claim this organization". The form is prefilled from the listing (name, country, register and number locked, website only when https, description, causes) and posts the organisation id, which the existing KYB apply flow treats as a claim.

### Deviations
- No link to an IRS page for US organisations (no stable public URL by EIN on irs.gov).
- The session decides the claim link on the server: in E2E (no Privy) the client auth context is never "authenticated".

### Test results
`apps/web/src/__tests__/market-cap-profile.test.ts` — 4 tests: `Tests 4 passed (4)`. Deliberate break — claimable for any status but PENDING:
```
   × Charity Market Cap profile > offers the claim only for an unclaimed imported organisation 18ms
AssertionError: expected true to be false // Object.is equality
      Tests  1 failed | 3 passed (4)
```
restored → passing. Web suite: `Test Files 66 passed (66)`, `Tests 558 passed (558)`.
E2E `market-cap-profile.spec.ts` (score, checks, register facts, OGL link, JSON-LD, axe with zero violations, 404; claim: login button for a visitor, prefilled locked form for a user), both viewports: `4 passed (18.7s)`. A first version decided the claim link in the browser only and failed (`waiting for getByRole('link', { name: 'Claim this organization' })`).

## Suggested commit messages
feat(worker): Trust Score v1 for every organisation (TASK-017a)
feat(web): Charity Market Cap list and methodology (TASK-017b)
feat(web): organisation profile and claim on the Charity Market Cap (TASK-017c)

## Fix after the first real imports (2026-10-08, David's dev check)
Dev had 615,372 organisations (171,904 UK + 443,462 US imported), but the Charity Market Cap listed only the one organisation on CHERR.IO: no imported organisation had a score. The registered part of the full pass is written first, so the full pass most likely failed at the imported part on real register values and was retried every minute.
- `trust.ts` (imported scores): register values are no longer cast — figures are counted only when they are JSON numbers, filing dates are compared as text after a strict shape check. A single malformed value (`"n/a"`, tax period `201913`, date `2023-02-30`) failed the whole statement before; a missing figure also produced a null score.
- `index.ts`: a failed full pass waits 30 minutes before the next try (was every minute over ~600k organisations); the log line names the scope.
- Profile page: register dates that are not real dates are left out instead of throwing (`lib/market-cap/facts.ts`, extracted so it can be tested).

Tests: `apps/worker/test/trust.test.ts` gained a US record with `revenue: "n/a"`, `taxPeriod: "201913"`, `financialYearEnd: "2023-02-30"` (scores 24.00 = active only). Old SQL against the new test:
```
   × Trust Score v1 (ADR-059) > imported organisations: 20 + 20 × completeness, at most 40; removed ones are not listed 11ms
PostgresError: invalid input syntax for type numeric: "n/a"
```
fixed → `Tests 4 passed (4)`; worker suite above. `src/__tests__/market-cap-facts.test.ts` (2); deliberate break (no date check) → `RangeError: Invalid time value`, restored → passing.
Not confirmed: the worker's real error message on dev (the session cannot read the server log).

# TASK-017 feedback — Trust Score v1 and Charity Market Cap
Spec: `docs/tasks/TASK-017-market-cap.md`; rules ADR-059.

## 017-schema (PR #174)
Status: DONE — Live on dev. Migration `0019`: `trust_scores` listing columns, unique `(org_id, version)`, partial ranking indexes; `pg_trgm` + trigram index on `organizations.name`. US registry import switched on for dev (David "ok nadaljuj").

## 017a — Trust Score worker
Status: DONE (Built; PR pending)

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

## Suggested commit message
feat(worker): Trust Score v1 for every organisation (TASK-017a)

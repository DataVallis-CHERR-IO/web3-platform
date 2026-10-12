# TASK-016 feedback — registry import
Spec: `docs/tasks/TASK-016-registry-import.md` (ADR-013).

## 016a — UK Charity Commission
Status: DONE — Live on dev (PR #171 merged 2026-10-08, all checks green; Deploy run 37767993993 green). The first real import on dev is still to be confirmed (worker log / admin "Imported" filter).
Prompt: David 2026-10-08 "gremo naprej z razvojem"; order agreed 2026-10-07 (ratings → registry import + Charity Market Cap).

### What I implemented
- `apps/worker/src/registry/tsv.ts`: opens the `.txt` inside a zip (yauzl) and yields rows of the tab-separated extract by header name — streamed, BOM removed, a record broken over several lines joined, backslash escapes undone.
- `apps/worker/src/registry/uk.ts`: `parseUkCharity` (main charities only; the kept fields; no contact details), `causesFrom` (classification descriptions → our 9 causes), `normaliseWebsite`, `importUkFromFiles` (classification first as a bit mask per charity number, then the charity file in batches of 500: `registry_records` upsert for all, `organizations` upsert for registered ones — `source = 'IMPORTED'` only, and only when something changed), `importUk` (downloads both zips to a temp folder, imports, removes them), `lastUkImport`.
- Worker: `REGISTRY_IMPORT=uk` (config) → background import when the newest UK record is older than 30 days, checked hourly; ticks continue meanwhile. `config/worker.dev.yml`: on for dev.
- Docs: spec, technical 03, 08 (operations), 09, tasks README; `THIRD_PARTY_NOTICES.md` (OGL v3.0 attribution needed on the Market Cap pages).

### Deviations
- The tab-separated extract is used instead of the JSON one: it streams line by line without a JSON-stream dependency.
- Only `yauzl` is added (zip reading; MIT). The Docker image needs no change: esbuild bundles it into `dist/index.mjs`.
- No database migration: `registry_records` and `organizations` already had what was needed.
- No PgBouncer-safe lock: two workers overlapping during a deploy could both start an import; both are idempotent upserts, so the result is the same.
- I could not download the real extract from this sandbox (egress allowlist): the format (column names) follows the Commission's extract as used by the open-source importer `kanedata/find-that-charity`; the first real run on dev is the check — see "How to verify".

### Test results
`apps/worker/test/registry.test.ts` (4 new: parsing/causes/websites/no contact data; import of the fixture extracts — 4 records, 2 organisations, 1 skipped subsidiary, removed one record-only, claimed one untouched, no contact details anywhere; re-run changes nothing and puts back an edited name; download through a local HTTP server, bad URL rejects):
```
 Test Files  2 passed (2)
      Tests  18 passed (18)
```
Deliberate break — the `source = 'IMPORTED'` guard removed (claimed organisation overwritten):
```
   × UK import (Postgres) > imports registered main charities as organisations, keeps removed ones as records, never touches a claimed one 56ms
     → expected { records: 4, …(2) } to deeply equal { records: 4, …(2) }
      Tests  1 failed | 3 passed (4)
```
restored → `Tests 4 passed (4)`. Typecheck and lint (worker): clean.

Speed and memory (synthetic extract: 390,000 charities, 1,170,000 classification rows; local Postgres; bundled runner with `--max-old-space-size=128`):
```
first  {"records":390000,"organizations":{"inserted":173335,"updated":0},"skipped":0} 32 s peak rss 125 MB heap 36 MB
second {"records":390000,"organizations":{"inserted":0,"updated":0},"skipped":0} 33 s peak rss 128 MB heap 34 MB
```
(A first version kept the classification descriptions as strings and used batches of 1,000: peak RSS 187–192 MB — at the worker container's 192 MB limit; bit masks and 500-row batches brought it to ~125 MB.)
Admin organisation list with those 173,335 imported organisations (scratch timing): first page 188 ms, search 357 ms, filter "Imported" 209 ms, counts 62 ms.

### How to verify (dev, after deploy)
1. Worker log: `[worker] started; … registry import uk`, then `[worker] UK registry import started` and, a few minutes later, `… done {"records":…}` (or `failed: …`).
2. https://dev.cherr.io/en/admin/organizations → filter "Imported" → about 170,000 UK charities.

### Open questions / risks
- 016b US scope and 016c Slovenian source: David.
- The admin organisation search over ~170,000 rows takes ~0.35 s; the Market Cap (TASK-017) needs its own indexes (sort by score, country, cause).

## Suggested commit message
feat(worker): monthly UK Charity Commission import (TASK-016a)

## 016b — US (IRS EO BMF)
Status: DONE — Live on dev (PR #173 merged 2026-10-08, all checks green; Deploy run 37777958907 green). Switched on for dev in the 017-schema PR after David's "ok nadaljuj".
Prompt: David 2026-10-08 — "samo organizacije 501(c)(3) ja" (answer to "501(c)(3) with revenue, or all?").

### What I implemented
- `registry/common.ts`: the batch writer shared by UK and US (`writeRegistryBatch`: one row per id per statement; `registry_records` rewritten only when `raw` changed), `markImported` (audit log `registry.imported` with the counts) and `lastImport` (from those marks).
- `registry/us.ts`: `csvFields` (quoted CSV), `titleCase` (IRS names are upper case; acronyms such as USA, YMCA, NY kept), `causesFromNtee` (NTEE major group → our causes), `parseUsOrganisation` (501(c)(3), revenue ≥ `US_MIN_REVENUE` default 1, no street / ZIP / "in care of"), `importUsFromStreams`, `importUs` (streams the four regional files, no temp files).
- Worker: `REGISTRY_IMPORT` accepts `uk,us`; imports run one at a time; `US_MIN_REVENUE`.

### Deviations
- "501(c)(3)" read as "501(c)(3) with revenue on the latest return" — what I proposed and David answered "ja" to; `US_MIN_REVENUE=0` would take all 501(c)(3) (≈1.5 M rows).
- Private foundations (FOUNDATION 02–04) are kept: they are 501(c)(3) too. Can be filtered later if David wants only public charities.
- **Not switched on for dev:** the US data needs ~0.5 GB in the dev database (measured on the synthetic run). Waiting for David's OK before `REGISTRY_IMPORT: uk,us` in `config/worker.dev.yml`.
- `lastImport` now reads the audit log instead of `max(fetched_at)`: unchanged records are no longer rewritten, so `fetched_at` cannot say when the last run was (UK too).

### Test results
`registry.test.ts` (2 new US tests: CSV quoting, title case, NTEE, no street/ZIP/"in care of", subsection and revenue filters, `US_MIN_REVENUE=0`; import of a 4-row sample → 2 kept, idempotent, two streamed downloads with duplicate EINs written once): worker suite `Tests 20 passed (20)`. A first run of the download test failed with "ON CONFLICT DO UPDATE command cannot affect row a second time" (the same EIN twice in one batch) → the writer now keeps one row per id.
Deliberate break — the subsection filter removed:
```
   × US import (TASK-016b: 501(c)(3) with revenue) > parses the BMF … → expected { registryId: '123456789', …(6) } to be null
   × US import … > imports only 501(c)(3) organisations with revenue … → expected { records: 3, …(2) } to deeply equal { records: 2, …(2) }
      Tests  2 failed | 4 passed (6)
```
restored → `Tests 6 passed (6)`. Typecheck, lint: clean.
Synthetic BMF (4 × 490,000 rows, 75 % 501(c)(3), half with revenue; bundled runner, `--max-old-space-size=128`):
```
first  {"records":735122,"organizations":{"inserted":735122,"updated":0},"skipped":1224878} 82 s peak rss 109 MB {"rr":"359 MB","org":"187 MB"}
second {"records":735122,"organizations":{"inserted":0,"updated":0},"skipped":1224878} 65 s peak rss 112 MB {"rr":"359 MB","org":"187 MB"}
```
(Before "only changed rows", a repeat run doubled `registry_records` to 668 MB until vacuum.)

### Suggested commit message
feat(worker): US IRS import of 501(c)(3) organisations (TASK-016b)

## UK names in capitals (David 2026-10-08: "ja, to lahko zdaj uredimo")
- `registry/uk.ts`: a name without lower-case letters is title-cased with the US `titleCase` ("BARNSLEY PREMIER LEISURE" → "Barnsley Premier Leisure"); mixed-case names are kept. `titleCase` keeps UK abbreviations (UK, CIO, CIC, NHS, RSPCA, RNLI, PTA, PTFA), writes Inc/Ltd, and no longer capitalises after an apostrophe ("Mary's", was "Mary'S").
- Import marks carry a parser version (`markImported(…, parser)`, `lastImport(…, parser)`); `UK_PARSER_VERSION = 2`, so the worker imports the UK register again right after this deploy instead of in 30 days (~170k names rewritten once on dev).
- Tests: worker `Tests 25 passed (25)`; deliberate break (parser version ignored by `lastImport`) →
```
   × UK import (Postgres) > imports registered main charities as organisations, keeps removed ones as records, never touches a claimed one 54ms
      Tests  1 failed | 24 passed (25)
```
restored → passing.

## 016c — Slovenia (AJPES ENO, ADR-062)
Status: DONE (Built, PR pending) — the REVIEW queue page is 016d.
Prompt: David 2026-10-09 "naredi raziskavo kje lahko dobimo bazo dobrodelnih organizacij slovenije … da so res dobrodelne"; 2026-10-12 "tako ja, uredi" (both field lists) + "1x mesečno posodabljali".

### What I implemented
- `apps/worker/src/registry/si.ts`: `enoOrganisations` (small scanner for the flat ENO XML — entities decoded, BOM ignored, no XML dependency), `classifySi` (ACCEPT / REVIEW / EXCLUDE / REMOVED by the public-interest field in force on the day), `fieldCauses` + `SI_ACCEPTED_FIELDS` (exact ENO field names → causes; every "Humanitarna dejavnost – …" sub-field), `titleCaseSl`, `siEntry`, `importSiFromXml` (batches of 500 through `writeRegistryBatch`; then every `SI_AJPES` record missing from the extract → `status: Removed`, `reason: not-in-extract`; refuses < 3,000 organisations), `downloadEno` (last month's file, else the month before; refuses a non-ENO body), `importSi`, `lastSiImport`, `SI_PARSER_VERSION = 1`.
- Worker: `REGISTRY_IMPORT` accepts `si`; `REGISTRIES.si` → monthly with the others (30 days since the last finished run, checked hourly). `config/worker.dev.yml`: `uk,us,si`.
- Market Cap profile: Slovenian facts (registration number, public-interest status, since, municipality, legal form) and the source line `sourceSi`.
- Docs: ADR-062, spec 016c/016d, technical 01, 03, 08, 09, tasks README, fundraisers guide, `THIRD_PARTY_NOTICES.md`.

### Real data (the 2026-09 extract David attached, 10.1 MB, not committed)
Temporary test (deleted afterwards) against the local Postgres:
```
import {"records":6322,"organizations":{"inserted":2394,"updated":0},"skipped":0,"decisions":{"ACCEPT":2394,"REVIEW":348,"EXCLUDE":3576,"REMOVED":4},"missing":0,"extract":"2026-09"} ms 789
second run {"inserted":0,"updated":0} {"ACCEPT":2394,"REVIEW":348,"EXCLUDE":3576,"REMOVED":4}
trust {"scope":"all","written":2394}
by status [{"status":"Excluded","n":3576,"listed":0},{"status":"Registered","n":2394,"listed":2394},{"status":"Removed","n":4,"listed":0},{"status":"Review","n":348,"listed":0}]
```
Disaster field (1,826 with a status in force) by name, from the analysis script: fire brigades 1,448, radio clubs 86, scouts 79, caving 31, dog clubs without "rescue" 21, mountain rescue 18, divers 16, other rescuers 14, flying 8, other 106 (mostly alpine clubs, Red Cross units). REVIEW 348 = 259 disaster-field-not-rescue + 89 also-excluded-field.

### Tests
- `apps/worker/test/registry-si.test.ts` (12) with `test/fixtures/eno/ENO_sample.xml` in the real format: parsing, every decision path, future withdrawal/deletion, field → causes (sport, culture, defence, veterans never accepted), title case, Postgres import (3 organisations, records with decisions, no street address), idempotent re-run, claimed organisation untouched, missing → Removed → trust score `listed = false` → back → listed, short extract refused, download fallback through a local HTTP server.
- `pnpm --filter worker test`: `Test Files 4 passed (4)`, `Tests 40 passed (40)`.
- `apps/web/src/__tests__/market-cap-facts.test.ts`: `Tests 3 passed (3)`.
- Lint and typecheck (web, worker): Done.
- **Deliberate break:** `ACCEPT: "Accepted"` instead of `"Registered"` in `RAW_STATUS` → 3 failed (`expected { …(12) } to match object { status: 'Registered', …(4) }`, `expected false to be true` for the trust listing); restored → `Tests 12 passed (12)`.

### Deviations / left out on purpose
- No admin page yet for the 348 REVIEW organisations (016d) — they are kept as records and not shown.
- Names title-cased word by word like the UK import ("Društvo za Pomoč Osebam z Motnjami"): sentence case would break place names ("Škofja Loka").
- An organisation that passed KYB (`REGISTERED`) and later loses its ENO status stays listed (listing of registered organisations follows KYB); the record shows `Removed` for the admin.
- The download from AJPES was not tried from this sandbox (egress blocks ajpes.si); the first run on dev is the check.

### How to verify (dev, after deploy)
1. Worker log: `[worker] SI registry import done {"records":6322,…,"decisions":{"ACCEPT":2394,…}` (numbers move monthly).
2. https://dev.cherr.io/en/charity-market-cap → country Slovenia → e.g. "Prostovoljno Gasilsko Društvo …"; the profile shows "Public-interest status" and the AJPES source line.

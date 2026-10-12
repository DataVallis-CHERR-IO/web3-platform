# TASK-016 — Registry import (ADR-013)

Order agreed 2026-10-07: sharing → Proof of Charity v2 → ratings → **this** → Charity Market Cap (TASK-017).

## Goal
Fill the Charity Market Cap with organisations that are not on CHERR.IO yet, from public registries, so donors can compare and charities can **claim** their profile (existing KYB claim flow: `apply.ts` / `review.ts`).

## Parts
- **016a — UK (Charity Commission for England and Wales), this PR.** Daily public extract, Open Government Licence v3.0, tab-separated text in zips:
  `https://ccewuksprdoneregsadata1.blob.core.windows.net/data/txt/publicextract.charity.zip` and `…/publicextract.charity_classification.zip`.
  - Main charities only (`linked_charity_number = 0`); subsidiaries skipped.
  - `app.registry_records` (`UK_CC`, charity number): every main charity, registered or removed, with a **selection** of fields: name, status, type, registered/removed date, reporting status, financial year end, income, expenditure, company number, insolvent / in administration, extract date. **No phone, e-mail or postal address** (some small charities use a trustee's home).
  - `app.organizations` (source `IMPORTED`, country GB, registry `UK_CC`): the **registered** ones — name, website (normalised), activities as description (≤ 1,000 characters), causes from the "What"/"Who" classifications. An organisation that was claimed (source `REGISTERED`) is never changed; an imported one is updated only when the data changed.
  - Worker: `REGISTRY_IMPORT=uk` → in the background once every 30 days (checked hourly against the newest `fetched_at`); ticks keep running. On dev: on.
- **016b — US (IRS Exempt Organizations Business Master File), this PR.** David 2026-10-08: **only 501(c)(3) organisations** (subsection 03), with revenue on the latest return (`REVENUE_AMT > 0`, my recommendation he agreed to; `US_MIN_REVENUE` changes it). Four regional CSV files `https://www.irs.gov/pub/irs-soi/eo1.csv` … `eo4.csv` (US public domain), streamed — no temporary files. Kept: name (title case), city, state, classification, ruling, deductibility, foundation, status, tax period, assets, income, revenue, NTEE; **never street, ZIP or the "in care of" name**. Causes from the NTEE major group. Worker: `REGISTRY_IMPORT=uk,us`.
- **016c — Slovenia (AJPES ENO, ADR-062), this PR.** David 2026-10-12 accepted the field lists ("tako ja, uredi") after the research of 2026-10-09 (FURS 1 % list mixes parties, unions, churches; SKD 88.991 is self-declared). Source: the monthly ENO XML (`ENO_YYYY_MM.xml`, last month's, else the month before). One organisation per registration number (matična številka), statuses in force only. Decision by the **public-interest field a ministry granted** (`classifySi`): ACCEPT (accepted field) → `organizations` (`SI`, `SI_AJPES`, causes by field); REVIEW (only the disaster field and no fire/rescue/Red Cross name, or an accepted plus an excluded field) and EXCLUDE → records only; REMOVED (deleted, all statuses withdrawn, missing from the newest extract) → record `status: Removed`, off the Market Cap. Kept in `raw`: name, status, reason, public-interest fields and since when, tax number, legal form, seat, municipality, ministry, removal date, extract month — **no street address**. Names in capitals title-cased (Slovenian letters). Refuses an extract with fewer than 3,000 organisations. Worker: `REGISTRY_IMPORT=uk,us,si` (on for dev). Market Cap profile shows the fields, since when, municipality and legal form. Real extract 2026-09 (from David): 6,322 organisations → 2,394 ACCEPT, 348 REVIEW, 3,576 EXCLUDE, 4 REMOVED.
- **016d — admin review of the REVIEW queue (next).** Admin → Organisations → "Slovenian register — to review": accept or keep out; the decision survives the monthly import.

## Not in scope
Market Cap pages, Trust Score (TASK-017); removing imported organisations that disappear from the register (their record says `Removed`; TASK-017 hides them). 016c: matching a Slovenian KYB application typed with a 7-digit number to the 10-digit ENO number; the admin review page (016d).

## Tests
Worker tests against Postgres with two tiny extracts in the real format (zip, BOM, CRLF, a record broken over two lines, a backslash escape, a subsidiary, a removed charity, a claimed organisation): what is imported, no contact details stored, idempotent re-run, update after a change, download through a local HTTP server. Speed and memory on a synthetic 390,000-row extract.

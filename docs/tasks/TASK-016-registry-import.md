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
- **016b — US (IRS Exempt Organizations Business Master File).** David 2026-10-08: **only 501(c)(3) organisations** (subsection 03).
- **016c — Slovenia.** Open (David 2026-10-08: "še ne vem" — the available lists mix all kinds of associations (društva), which is not what we want). Not scheduled until he decides on a source.

## Not in scope
Market Cap pages, Trust Score (TASK-017); removing imported organisations that disappear from the register (their record says `Removed`; TASK-017 hides them).

## Tests
Worker tests against Postgres with two tiny extracts in the real format (zip, BOM, CRLF, a record broken over two lines, a backslash escape, a subsidiary, a removed charity, a claimed organisation): what is imported, no contact details stored, idempotent re-run, update after a change, download through a local HTTP server. Speed and memory on a synthetic 390,000-row extract.

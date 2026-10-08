# TASK-017 — Trust Score v1 and Charity Market Cap (ADR-013, ADR-059)

Order agreed 2026-10-07: … ratings (057) → registry import (016) → **this**. David 2026-10-08: "ok nadaljuj".

## Parts
- **017-schema** — migration `0019`: `trust_scores` gets `listed`, `registered`, `country`, `causes`, `raised`, a unique `(org_id, version)` and ranking indexes (partial on `listed`); `pg_trgm` + trigram index on `organizations.name`. No code reads `trust_scores` yet. Also: US registry import on for dev (`REGISTRY_IMPORT: uk,us`, David "ok").
- **017a** — worker `trust.ts`: one set-based SQL pass computes every organisation's v1 score (ADR-059) and upserts rows whose score or listing fields changed; nightly (03:00 UTC) and at most every 10 minutes after events (new rating, campaign state change, KYB decision). Tests for every component, the cap for imported organisations, not-listed cases, idempotency; timing on ~1 M organisations.
- **017b** — public pages: `/charity-market-cap` (rank, name, country, causes, score, raised on CHERR.IO, "On CHERR.IO" / "Not on CHERR.IO"; sort by score / raised / name; filters country (in use), cause, on/not on CHERR.IO; search by name; keyset pagination), organisation profile `/charity-market-cap/[id]` (score with components, rating, campaigns, raised, registry facts, "Claim this organization" for imported ones → existing KYB claim), methodology page, JSON-LD `Organization` + `AggregateRating`, OGL v3.0 attribution for UK data, IRS source line for US data.

## Tests
Vitest (worker + web) against Postgres with the fake chain; E2E for the list, the profile and the claim link; a11y; speed on ~1 M organisations.

# TASK-052 — Storage clean-up: evidence and public media

Status: Built · Owner decision: none needed (pre-MVP list, HANDOFF "Next 4"; David's go-ahead 2026-10-07: "uredi")

## Problem
- `files:sweep` (TASK-008a-2, ADR-034) removes orphan objects only under `kyb/` in the private bucket. Evidence files (TASK-033c, ADR-047) live under `evidence/<campaign>/<file>`; an object whose delete failed, or an upload that stopped between storing the object and inserting the row, stays forever.
- The public bucket (ADR-037) has no sweep at all: replaced covers/images whose delete failed, objects of deleted draft campaigns, and demo covers that lost a race (TASK-038b) stay.

## Scope
1. Private: the orphan rule also lists `evidence/` (`ORPHAN_PREFIXES = ["kyb/", "evidence/"]`). Evidence rows are marked deleted in the same transaction that removes their `evidence_files` row, so "no live `private_files` row" is the right test; no separate rule needed.
2. Public: `sweepPublicMedia` (`apps/web/src/lib/media/sweep.ts`) lists `campaigns/` and deletes objects older than 1 h that none of these name: `campaign_media.cid`, `evidence_files.public_key`, `evidence_bundles.public_cids`. Every public key in the code is written under `campaigns/` and read from those columns (checked: every `publicMediaUrl(` caller).
3. `files.mjs sweep [--dry-run]` runs both and prints a second line of counts; exit 1 on any failed delete.
4. Tests: `media-sweep.test.ts` (Postgres + s3mock), limited to the run's own campaign prefix because other test files write to the same buckets.

## Out of scope (on purpose)
- Scheduling the sweep in the worker — it stays a weekly manual command (CHEATSHEET), as before.
- Deleting a draft campaign's objects at the moment the draft is deleted — the sweep catches them an hour later.
- A "too many orphans" safety stop — the sweep reads the same environment's database and bucket inside one container; `--dry-run` first stays the documented routine.

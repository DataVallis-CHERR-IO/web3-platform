# TASK-052 feedback
Status: DONE

## What I implemented
- Private sweep: orphan rule also covers `evidence/` (`ORPHAN_PREFIXES` in `apps/web/src/lib/files/sweep.ts`); optional `orphanPrefixes` so tests can narrow it to their own prefix.
- Public sweep: `sweepPublicMedia` in `apps/web/src/lib/media/sweep.ts` — lists `campaigns/`, keeps every key named by `campaign_media.cid`, `evidence_files.public_key` or `evidence_bundles.public_cids`, deletes the rest when older than 1 h; refuses a prefix outside `campaigns/`.
- `publicObjectStore()` in `apps/web/src/lib/media/public-store.ts` (the public bucket as an `ObjectStore`, same credentials).
- `files.mjs sweep [--dry-run]` runs both and prints a second line; exit 1 when any delete failed.

## Files changed
- `apps/web/src/lib/files/sweep.ts` — `evidence/` prefix, `orphanPrefixes` option
- `apps/web/src/lib/media/sweep.ts` — new public sweep
- `apps/web/src/lib/media/public-store.ts` — `publicObjectStore()`
- `apps/web/scripts/files.ts` — runs the public sweep too
- `apps/web/src/__tests__/media-sweep.test.ts` — new tests (4)
- `apps/web/src/__tests__/files-integration.test.ts` — its full-bucket sweep test narrowed to `kyb/` (evidence-db.test.ts writes `evidence/` objects in parallel)
- `docs/technical/08-operations.md` §5.2, `docs/technical/09-status-and-roadmap.md`, `docs/CHEATSHEET.md`, `docs/tasks/README.md`, task spec

## Deviations from the task (and why)
- HANDOFF suggested an evidence rule "no `evidence_files` row". Not needed: an evidence `private_files` row is marked deleted in the same transaction that deletes its `evidence_files` row, and both rows are inserted in one transaction, so "no live `private_files` row" already finds every leftover object.

## New dependencies
- none

## How to verify
1. Locally: `pnpm --filter web exec vitest run src/__tests__/media-sweep.test.ts` (needs Postgres + the local S3).
2. On dev after the deploy (David): `docker exec <web container> node apps/web/dist/files.mjs sweep --dry-run` → two lines; the second reads `files:sweep public media (dry run — nothing deleted): N object(s) under campaigns/ that no row refers to (older than 1 h), 0 failed delete(s)`. Then `… sweep` without `--dry-run`.

## Test results
```
pnpm exec vitest run src/__tests__/media-sweep.test.ts src/__tests__/files-integration.test.ts src/__tests__/evidence-db.test.ts
 Test Files  3 passed (3)
      Tests  22 passed (22)
pnpm --filter web lint / typecheck → clean
```
CLI bundle built with the Dockerfile's esbuild command and run against the local DB + S3:
```
files:sweep (dry run — nothing deleted): 0 unattached file(s) older than 24 h, 0 file(s) of applications rejected more than 90 days ago, 0 object(s) without a live row, 0 failed delete(s)
files:sweep public media (dry run — nothing deleted): 0 object(s) under campaigns/ that no row refers to (older than 1 h), 0 failed delete(s)
exit 0
```

Deliberate break 1 — `evidence_bundles.public_cids` left out of the keep set:
```
× … public: deletes only objects no row names, older than 1 h; cover, evidence file and sealed key stay
AssertionError: expected [ …(2) ] to deeply equal [ Array(1) ]
      Tests  1 failed | 3 passed (4)
```
Deliberate break 2 — `ORPHAN_PREFIXES` back to `["kyb/"]`:
```
× … the CLI defaults cover kyb/ and evidence/ (private) and campaigns/ (public)
AssertionError: expected [ 'kyb/' ] to deeply equal [ 'evidence/', 'kyb/' ]
      Tests  1 failed | 3 passed (4)
```
Both restored → `Tests  4 passed (4)`.

## Open questions / risks
- The first real run on dev may delete demo covers and replaced images left from earlier testing; that is the point, but run `--dry-run` first and look at the count.
- Still manual (weekly). Scheduling it in the worker stays an open item.

## Suggested commit message
feat(web): files:sweep also cleans evidence/ and public campaign media (TASK-052)

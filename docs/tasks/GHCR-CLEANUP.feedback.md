# GHCR clean-up feedback
Status: DONE (built; first real run is manual, dry run first)

David 2026-10-09: "ok uredi" (item 3 of the list); packages are **private** (web 461, indexer 157, worker 112 versions) → storage costs money.

## What I implemented
- `.github/scripts/ghcr-cleanup.sh <org> <package> [--apply]`: lists all versions (`gh api --paginate orgs/<org>/packages/container/<pkg>/versions`), reads every version that carries a deploy (non-`tree-*`) tag with `docker buildx imagetools inspect --raw` and protects its child digests, then deletes versions whose every tag is `tree-*`, older than `KEEP_DAYS` (21) and not protected. Untagged versions are never touched; only `cherrio/web|worker|indexer` are accepted; an unreadable index stops before any delete. Without `--apply` it only prints (dry run). A `::notice::` per package carries the counts (readable via the check-run annotations).
- `.github/workflows/ghcr-cleanup.yml`: manual ("Run workflow"), input **apply** (unticked = dry run), matrix of the three packages, `packages: write`, 15-minute timeout, no schedule (repo rule: no `schedule:` triggers).
- `ghcr-cleanup.test.sh` added to CI "Changed areas" next to the other deploy script tests.

## Deviations / decisions
- Manual, not automatic after every Deploy: the first runs should be looked at; can be wired into Deploy later if wanted.
- **Independent reviewer subagent** (before the PR): HIGH — `imagetools create` wraps a reused single-manifest tested image in a **new index**, so the tested version stays tree-only; my first version protected only children of the newest 30 deploy versions → older rollback images could lose their content. Fixed: protect children of **all** deploy-tagged versions. MEDIUM — `KEEP_DAYS` 7 raced the 14-day `tested-image` artifact retention → 21. MEDIUM — API order not documented → no ordering assumption left. LOW — `tr | grep` under pipefail replaced by a bash loop; package allowlist added. Open MEDIUM: the repo needs the **Admin** role in each package's "Manage Actions access" to delete; if not, the first `--apply` fails with 403 on the first delete (safe).

## How to verify
1. `bash .github/scripts/ghcr-cleanup.test.sh`
2. GitHub → Actions → "GHCR clean-up" → Run workflow (apply unticked) → each job's notice: "would delete N of M versions".
3. Then run again with **apply** ticked.

## Test results (real output)
```
ok: cherrio/web: 9 versions, 2 old tree-only to delete, 3 tree-only kept
ok: would delete 5 tree-dev-4444
ok: deleted 6 tree-uat-5555,tree-dev-6666
ok: 3 old tree-only to delete
ok: 0 old tree-only to delete
ok: stopping, nothing deleted
ok: bad package
ok: bad package
ok: unknown option
ok: KEEP_DAYS must be
exit=0
```
- `shellcheck` and `actionlint` clean.
- Deliberate break (protection check removed):
  ```
  FAIL (cherrio/web: 9 versions, 2 old tree-only to delete, 3 tree-only kept): exit 0 — cherrio/web: 9 versions, 4 old tree-only to delete, 1 tree-only kept (recent or referenced).
  FAIL: expected 2 deletes, got 4
  FAIL: deleted kept version 4
  FAIL: deleted kept version 9
  ```
  restored → all ok, exit 0.
- **First real dry run (2026-10-09, run 37954224158, dispatched by the session after the merge of PR #194, green):**
  ```
  GHCR clean-up cherrio/web (dry run): would delete 0 of 453 versions; 14 tree-only kept
  GHCR clean-up cherrio/indexer (dry run): would delete 0 of 157 versions; 0 tree-only kept
  GHCR clean-up cherrio/worker (dry run): would delete 0 of 98 versions; 6 tree-only kept
  ```
  Listing and index inspection work with `GITHUB_TOKEN`. Build once only started on 2026-10-08, so all tree-only images are recent; **almost all versions are Deploy builds** (a `sha-*` index plus untagged attestation children) and indexer builds. Removing those (keep e.g. the last 20 deploys per package) is a separate decision for David — it limits how far back `kamal rollback` can go.

## docs/technical chapters updated
- `07-delivery-and-quality.md` (build once → GHCR clean-up).

## Part 2 — deploy images (David 2026-10-09: "ja uredi to" — keep the last 20 per package)
- The first dry run showed that tested images are not the problem: almost all versions are Deploy builds. The script now keeps the 20 newest deploy images per package and deletes older ones with their children (and old orphans). Rules in `docs/technical/07` (build once → GHCR clean-up).
- **Second independent review:** HIGH — GHCR keeps the old `created_at` when an existing digest gets a new tag (Deploy re-run, same tested image reused again), so the running dev image could rank outside the newest 20 → ranking uses `max(created_at, updated_at)` **and** the tags of the last 50 successful Deploy runs are always kept. MEDIUM — the branch lookup swallowed every error → only a missing `uat` (404) is skipped; MEDIUM — nested index under a tested image → followed one level further; MEDIUM — race with Deploy → stop when a Deploy run is queued/in progress, at the start and again before deleting; LOW — final filter never deletes a kept digest or a kept child. Workflow timeout 30 min, `actions: read` added.
- Deliberate breaks: no recursion → `FAIL: deleted '6 9 11 13 601 602 ', want '6 9 11 601 602 '`; no Deploy-run protection → `FAIL: deleted '6 9 11 99 601 602 9901 ', want …`; 21-day keep instead of "last 20" → `FAIL: recent sixth deploy: deleted '9 11 '`; restored → all ok.
- Test output now:
```
ok: cherrio/web: 25 versions; deploy images 8 (keep 7); delete 5; other kept
ok: would delete 6 sha-6666666
ok: deleted 602 tree-dev-ffff
ok: deploy images 8 (keep 8); delete 2
ok: deploy images 8 (keep 7); delete 5
ok: cannot inspect ghcr.io/datavallis-cherr-io/cherrio/web@sha256:idx6
ok: cannot inspect ghcr.io/datavallis-cherr-io/cherrio/web@sha256:idx2
ok: cannot inspect ghcr.io/datavallis-cherr-io/cherrio/web@sha256:latest
ok: a Deploy run is queued or in progress
ok: a Deploy run started — nothing deleted
ok: cannot read the commits of main
ok: bad package
ok: bad package
ok: unknown option
ok: KEEP_DAYS must be
ok: KEEP_DEPLOYS must be
exit=0
```

## Suggested commit message
ci: manual GHCR clean-up of old tree-only tested images

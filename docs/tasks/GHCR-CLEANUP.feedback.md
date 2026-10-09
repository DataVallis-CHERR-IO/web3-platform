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
- NOT RUN against GHCR: the sandbox cannot reach org package endpoints; the first real (dry) run is David's "Run workflow" (or the session's dispatch after the merge).

## docs/technical chapters updated
- `07-delivery-and-quality.md` (build once → GHCR clean-up).

## Suggested commit message
ci: manual GHCR clean-up of old tree-only tested images

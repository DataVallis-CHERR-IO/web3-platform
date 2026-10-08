# BUILD-ONCE feedback — deploy reuses the image CI tested
Status: DONE (Built; PR pending) — David 2026-10-08: "to moramo pohitrit, ne morem za spreminjanje malenkosti čakat 30 min" → "Pospešitev deploya … ja to prvo".

## Measured before
PR #181: CI 7 min (17:32–17:39); Deploy 5 min 17 s, of which "Build → Deploy → Migrate" 5 min 01 s with ~4 min image build; worker job builds its image again when worker inputs change.

## What I implemented
- `.github/scripts/reuse-image.sh` (+ `reuse-image.test.sh`, run in CI "Changed areas"): merge commit → merged same-repository PR → its successful CI run → artifact `tested-image-<web|worker>` ("tree digest-ref"); tree must equal the deployed commit's tree; then `imagetools create --tag <image>:sha-<7> <image>@sha256:…`. Prod always builds; any miss or error builds (never fails the deploy).
- `ci.yml` "Image build": label `service=cherrio-<image>-<base>` (Kamal refuses unlabelled images); same-repo PRs into dev/uat push `…:tree-<base>-<tree>` and upload the artifact; both steps `continue-on-error`.
- `deploy.yml`: reuse step before the web and worker builds (build only if not reused); permissions `actions: read`, `pull-requests: read`; no `NEXT_PUBLIC_GIT_SHA` build arg; smoke test checks `"version":"sha-<7>"`.
- `Dockerfile`: no baked commit id. `/api/health`: `version` from `KAMAL_VERSION` (Kamal 2.12 sets `--env KAMAL_VERSION=<version>` on every app container — read in Kamal's `lib/kamal/commands/app.rb` v2.12.0), `sha` = its 7 characters.

## Independent review (subagent, before the PR)
No critical. Medium: a tag keyed only by the tree could be pushed by another (unmerged) PR for a predictable future tree → fixed with the artifact from the merged PR's own run + tagging by digest. Medium: a failed GHCR push would turn a required check red → `continue-on-error`. Low: stale CI comment and docs → fixed; GHCR growth (`tree-*` tags) → not done yet.

## Test results
- `bash .github/scripts/reuse-image.test.sh`: 12 × ok. Deliberate break (tree comparison disabled):
```
FAIL (dev moved before the merge): exit 0 — Reusing ghcr.io/datavallis-cherr-io/cherrio/web@sha256:aaaa… (tested in CI run 42) as ghcr.io/datavallis-cherr-io/cherrio/web:sha-abc1234.
```
  restored → all ok.
- `actionlint` 1.7.7 on all workflows: clean; `shellcheck` on both scripts: clean.
- `apps/web/src/__tests__/health.test.ts`: `Tests 6 passed (6)` (new: version from `KAMAL_VERSION`).
- Real proof comes from the merge of this PR's successor: this PR's own deploy builds (its CI run has no artifact yet under the old workflow? — it runs the new `ci.yml`, so it may already reuse); see the Deploy log line "Reusing …" or "… — building.".

## Open
- Clean-up of old `tree-*` images in GHCR (e.g. weekly `actions/delete-package-versions`).
- Indexer image still builds on deploy (it bakes `GIT_SHA7`; rarely deployed).

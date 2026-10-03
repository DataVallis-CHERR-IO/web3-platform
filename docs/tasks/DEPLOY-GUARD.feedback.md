# DEPLOY-GUARD feedback — branch ↔ environment guard for manual deploys
Status: DONE — Live on dev (PR #53, Deploy run 37130890170: job "Branch ↔ environment guard" success)

Prompt (ad hoc, David 2026-10-03): before switching the GitHub default branch from `main` to `dev`, check that nothing depends on the default branch; fix what must change.

## Why
- `deploy.yml` has a `workflow_dispatch` trigger with an `environment` choice (`dev | uat | prod`).
- GitHub shows "Run workflow" only when the workflow file is on the default branch. `main` has no `deploy.yml`, so the button does not exist today.
- After the switch to `dev`, the button appears with branch `dev` preselected. Branch and environment are picked independently, and nothing checked that they match: branch `dev` + environment `prod` would build dev's code and deploy it, with migrations, to production.

## Audit (default-branch dependencies), 2026-10-03
- `schedule:` triggers: none in `.github/workflows/*`.
- `github.event.repository.default_branch`, `refs/heads/main`: not referenced.
- `ci.yml`: push/PR on `dev`, `uat`, `main` — independent of the default branch.
- `promotion-guard.yml`: checks `base_ref`/`head_ref` only — unaffected.
- `deploy.yml`: `workflow_dispatch` — the risk above; fixed here.
- GHA caches: the default branch's cache is readable from every branch — after the switch, uat/main runs can reuse dev's cache (an improvement).
- CODEOWNERS: none. Branch protection: none (documented as "the discipline is ours").
- `main` today: commit `1b61bc0` (2026-09-29), contains `.DS_Store`, `.augment`, `.idea`, `docs` — no licence, no code. `uat` does not exist on the remote.

## What I implemented
- `.github/scripts/check-deploy-target.sh` — allows `dev→dev`, `uat→uat`, `main→prod` on `workflow_dispatch`; everything else fails; push events pass.
- `.github/scripts/check-deploy-target.test.sh` — 13 cases.
- `deploy.yml` — new first job `guard`; `deploy` and `indexer-changes` `need` it. Values passed via `env:` (branch names are user input).
- `ci.yml` — "Changed areas" job runs the guard tests on every PR.
- `docs/technical/07-delivery-and-quality.md` §4.0.

## Test results (real output, this session)
```
$ bash .github/scripts/check-deploy-target.test.sh; echo "exit=$?"
ok   pass: workflow_dispatch dev dev
ok   pass: workflow_dispatch uat uat
ok   pass: workflow_dispatch main prod
ok   fail: workflow_dispatch dev prod
ok   fail: workflow_dispatch dev uat
ok   fail: workflow_dispatch uat prod
ok   fail: workflow_dispatch main dev
ok   fail: workflow_dispatch main uat
ok   fail: workflow_dispatch feat/x dev
ok   fail: workflow_dispatch hotfix/y prod
ok   fail: workflow_dispatch main 
ok   pass: push dev 
ok   pass: push uat 
exit=0
```

Deliberate break — `dev` mapped to `prod` in the script:
```
FAIL expected pass, got fail: workflow_dispatch dev dev
FAIL expected fail, got pass: workflow_dispatch dev prod
exit=1
restored exit=0
```

YAML of both workflows parsed with PyYAML: ok. The guard job itself runs for the first time on the push to dev after this merge (NOT RUN locally — GitHub Actions only).

## After the merge (2026-10-03)
- Deploy run 37130890170 on `a0773d6`: Branch ↔ environment guard: success; Build → Deploy → Migrate: success; Indexer — changed?: success; Indexer — Build → Deploy → Ready → Reconcile → Prune: success.
- David switched the default branch to `dev`. Docs updated in the follow-up docs PR.

## Open items / for David
- Recommended (GitHub UI, cannot be checked from the cloud session): Settings → Environments → `prod` → Deployment branches → only `main`. A second lock beside this guard.
- After the switch: docs PR — HANDOFF, CHEATSHEET §6/§10, 07 (L63, L102, L117), 08 (L39–40), `runbooks/prod-launch.md` C.6.

## Suggested commit message
fix(ci): refuse manual deploys whose environment does not match the branch

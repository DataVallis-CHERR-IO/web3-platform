# CI speed (PR #132) feedback
Status: DONE — Live (PR #132 merged 2026-10-06, CI 37495198539 + Deploy 37495198545 green)

Prompt: David's fast CI/CD recipe (project doc `blueprint/CI-CD-FAST-PIPELINE.md`), "uredi, samo da ne bomo meli več dela kot koristi".

## Measured before (green runs, 2026-10-06)
- PR CI with code: 11.8–13.9 min; critical path typescript 3.5–5.4 min → E2E 6.6–8.2 min (E2E steps: containers 15 s, install 9 s, Playwright 26 s, web build 159 s, tests 266 s).
- Push to dev: CI image builds 4.5–6.1 min (parallel); Deploy 5.9–7.7 min, web "Build and push image" 232–268 s, Kamal deploy ~30 s.
- Tests already ran only on PRs; docs-only merges already skipped the deploy.

## What I implemented
- `ci.yml`: `e2e` and `indexer` need only `changes`, explicit `github.event_name == 'pull_request'`; E2E matrix of two Playwright shards (`--shard=n/2`, 89 + 89 of 178 runs by `--list`); verdict job `e2e-result` under the required check name "E2E — a11y, no-Google-Fonts, organisation onboarding"; `timeout-minutes` on every job; head-guard tests in "Changed areas".
- `deploy.yml` guard: "A re-run is for the branch head" (`run_attempt > 1`), `.github/scripts/check-deploy-head.sh` + `.test.sh` (6 cases).
- `docs/technical/07` §3, §4.0, §4.3 (rollback = revert or `kamal rollback`; branch protection facts).

## Deviations
- Not done on purpose: build-once image reuse (needs commit-independent images — `NEXT_PUBLIC_GIT_SHA`, indexer `GIT_SHA7` — plus GHCR pushes from PRs; ~4 min per merge), plan script with tree-hash markers, a single "CI OK" required check (needs a branch-protection change). Reasons in the blueprint doc.
- Branch first pushed as `ci/faster-pr-checks` (not an allowed prefix), then moved to `fix/faster-pr-checks`; deleting the remote `ci/` branch was refused by the git proxy — David may delete it.

## Independent review (subagent, before merge)
- Found: (1) dev's branch protection requires the old E2E check name → verdict job added; (2) the head check on first attempts would strand a code deploy after a docs-only merge (docs-only pushes start no Deploy) → re-runs only. Both fixed in 763100c. Also noted: a stale required check "E2E — a11y + no-Google-Fonts" in dev's protection (no job reports it).

## Test results
- `check-deploy-head.test.sh`: 6/6 ok. Deliberate break (comparison disabled): `FAIL expected fail, got pass: 9177277fca31653928138f7e31aad9c006c00457 2e0cba667c7852affd35a580457c006795e68123`, exit 1; restored.
- actionlint clean (all workflows); shellcheck clean.
- PR #132 CI: all green in **7.3 min** (E2E shard 1/2 5.8 min, 2/2 4.6 min, verdict 0.1 min, typescript 5.4, indexer scenario 4.2, web image 5.1).
- Merge push: test jobs skipped, E2E verdict green; Deploy 37495198545 green, head step skipped (first attempt).

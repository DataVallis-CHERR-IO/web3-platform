# TASK-028 feedback — image builds in CI
Status: DONE — proven on GitHub by David (second pass, 2026-10-02, below); merged to `dev`.

## Steps for David

1. **Push the branch and open the PR to `dev`.** Expected in the PR's checks: "Image build (web)" and "Image build (indexer)", both green, next to the four existing jobs. The push to the feature branch alone must **not** start "Image build" (it is shown as skipped in that run); the pull-request run does.
2. **Note the two durations** of this first (cold-cache) run.
3. **Deliberate red run.** On the PR branch, in `apps/web/playwright.config.ts`, replace the line
   `import { E2E_SESSION_SECRET } from "./playwright.env";`
   with
   `import { E2E_SESSION_SECRET } from "./e2e/helpers/session";`
   and in `apps/web/e2e/helpers/session.ts` add the line
   `export const E2E_SESSION_SECRET = "e2e-session-secret-not-a-real-secret-0123456789abcdef";`
   in place of its `import { E2E_SESSION_SECRET } from "../../playwright.env";` line. Commit as `test: deliberate image-build break (revert me)` and push.
   - Expected: lint, typecheck, tests and E2E stay **green** (locally everything resolves — this is exactly the 008b-2 situation); **"Image build (web)" goes red** with `Type error: Cannot find module './e2e/helpers/session'`; "Image build (indexer)" stays green.
   - Then `git revert` that commit and push; all green again. Note the durations of this run too (warm cache).
4. **Branch protection** (if `dev` has required checks): add "Image build (web)" and "Image build (indexer)". Without that a red image build does not block a merge.
5. Send me the three run links or the durations; the second pass writes them into this file and turns **Built** into **Live** in technical 07 and 09.

## What I implemented
- **`.github/workflows/ci.yml`, job `images` — "Image build (web)" / "Image build (indexer)"**
  - no `needs`; matrix (`fail-fast: false`) with `Dockerfile` and `Dockerfile.indexer`;
  - job-level `if:` — pull-request events, or pushes to `dev`, `uat`, `main`;
  - `docker/setup-buildx-action@v3`, `docker/build-push-action@v6` with `push: false`, `cache-from` / `cache-to` `type=gha` (`mode=max`), scopes `ci-web` and `ci-indexer`;
  - build args as in the deploy workflow (`NEXT_PUBLIC_GIT_SHA`, `GIT_SHA7`);
  - web only: `load: true`, then `docker run --rm cherrio-web:ci node apps/web/dist/files.mjs`; the step fails unless the output contains `Usage: files check | files sweep [--dry-run]`.
- **`CLAUDE.md`**: the new docker rule (your sentence) as a hard rule; "docker build" removed from the heavy-jobs line; the E2E command is now `cd apps/web && CI=1 pnpm test:e2e` with what it needs; the local `docker build` line removed from "Useful commands".
- **`docs/tasks/TASK-028-ci-image-build.md`** — the task file, written from your message and the approved plan.

## Files changed
- `.github/workflows/ci.yml` — job `images` (66 lines added)
- `CLAUDE.md` — docker rule, E2E command
- `docs/tasks/TASK-028-ci-image-build.md` (new), `docs/tasks/README.md` (index row)
- `docs/technical/07-delivery-and-quality.md`, `docs/technical/09-status-and-roadmap.md`

### `docs/technical/` chapters updated
- **07** — §3: new row "Image build" in the CI table and a paragraph on why it exists and that images are no longer built on the laptop. **09** — row TASK-028 (In progress, Built). Dates already 2026-10-02.
- `docs/CHEATSHEET.md`: not changed — it does not list CI jobs.

## Deviations from the task (and why)
- **No `--help`:** the script has none; the step checks the usage line it prints without a command (it exits 1, which the step accepts). Agreed in the plan.
- **Both build args are passed to both images.** Each Dockerfile uses one; Docker prints a "build-arg not consumed" warning for the other. It keeps the matrix to four plain fields.
- **`docs/tasks/README.md`** got an index row (not in the scope list; every task has one there).

## New dependencies
- none (the two actions are the versions the deploy workflow already uses).

## How to verify
1. Read the job at the end of `.github/workflows/ci.yml`.
2. Steps 1–3 of "Steps for David".

## Test results (all from this session)
- `ci.yml` parses (js-yaml); jobs: `typescript, e2e, contracts, indexer, images`; `images` has no `needs`, the `if:` above, the two matrix entries and five steps.
- **The usage check, against the image built in TASK-008c-3** (no build in this task):
  - `docker run --rm cherrio-web:local node apps/web/dist/files.mjs` → `Usage: files check | files sweep [--dry-run]` → the step's condition passes;
  - the same check with a script that cannot be loaded (`node apps/web/dist/does-not-exist.mjs` → `node:internal/modules/cjs/loader … throw err`) → the condition fails, as intended.

## NOT RUN
- The job on GitHub — NOT RUN until pushed: the two builds, the cache scopes, `load: true`, the `if:` on a feature-branch push, and the deliberate red run.
- docker build locally — not run, by the task and the new rule.
- Lint, typecheck, unit tests, E2E — NOT RUN: no application or test code changed.
- Run times — not measured. My estimates from the plan (web 7–9 min cold, 4–6 warm; indexer 3–4 cold, 1–2 warm) are estimates only.

## Open questions / risks
- **A red "Image build" blocks a merge only as a required check** (step 4).
- **Cache:** PR builds are warm only from caches written on the base branch; the first PR after this merge is cold until a push to `dev` has run the job once. The four cache scopes (two deploy, two CI) share GitHub's 10 GB limit; if it is exceeded, older entries are evicted and builds get slower, not wrong.
- **The image is built twice per merged change:** once in CI (not pushed), once in the deploy workflow (pushed). They do not share a cache on purpose.
- **What the job does not prove:** that the container starts and serves requests. It proves the build and that one bundled script loads; `/api/health` is still first checked by the deploy.
- **The indexer entry builds without submodules,** like the deploy job; if the indexer image ever needs them, both must change.

## Suggested commit message
ci: build the web and indexer images on every PR (TASK-028)

## Second pass — results on GitHub (reported by David, 2026-10-02)

I did not see these runs myself; the figures are as David reported them.

- **First PR run (cold cache):** "Image build (web)" green in 5 min, "Image build (indexer)" green in 2 min. The push run on the feature branch was skipped, as designed.
- **Deliberate break** (`playwright.config.ts` importing `./e2e/helpers/session`): "Image build (web)" failed after 3 min. "Lint, Typecheck, Test & Build" failed too, at typecheck.
- **After `git revert`:** everything green again. Merged to `dev`.

What this proves, and what it does not:
- Proven: the job runs on PRs, is skipped on feature-branch pushes, builds both images, and goes red when the web image cannot be built.
- Not isolated: my "Steps for David" predicted that typecheck would stay green and only the image build would fail. Typecheck failed as well, so this particular break was one the existing job also catches. The likely reason is that only the import in `playwright.config.ts` was changed, without putting the exported constant back into `e2e/helpers/session.ts` (the second half of step 3) — then the import fails everywhere, not only inside the Docker build context. I have not seen the error text, so this is an inference. The case the job was added for — a build that fails **only** in the image — is therefore still shown only by the local build failure recorded in `TASK-008c3.feedback.md`. If you want it shown in CI, repeat step 3 with both edits.
- Warm-cache durations were not reported; the estimates in the plan are still unmeasured.
- Required checks (step 4): not enforceable on this private repository (GitHub Free organisation). David merges manually, and only when all checks are green.
- The incomplete break was accepted by David (2026-10-02): it followed his instruction, and no repeat is needed.

# TASK-028 — Build the web and indexer images in CI on every PR

Branch: `chore/TASK-028-ci-docker-build` (from `dev`) · PR → `dev` · Depends on: TASK-008 (the bug that motivated it) · Written from David's message of 2026-10-02 and the approved plan.

## Goal

Catch image-build failures before merge — like the `.dockerignore` / `playwright.config.ts` bug from TASK-008b-2, where a file outside the Docker build context was imported by a file that `next build` type-checks — and stop building images on the laptop.

## Scope

1. **`.github/workflows/ci.yml` — new job "Image build"**
   - Needs nothing; runs in parallel with the other jobs.
   - Matrix with two entries, `web` (`Dockerfile`) and `indexer` (`Dockerfile.indexer`), so each image has its own status.
   - `docker/build-push-action` with `push: false`; GitHub Actions cache (`cache-from` / `cache-to` `type=gha`) with the scopes `ci-web` and `ci-indexer` — not the deploy scopes.
   - No path filter: it always runs on pull requests. Job-level `if:`: pull-request events, and pushes to `dev`, `uat` and `main` only — not pushes to feature branches.
2. **The web entry proves the bundled script loads:** the image is loaded (`load: true`) and `node apps/web/dist/files.mjs` is run inside it; the step passes only if the usage line is printed. No `--help` flag is added to the script. The indexer image is built only (`load: false`).
3. **`CLAUDE.md`**
   - Replace the "docker build only when the task touches the image" line with: "Do not run docker build locally; CI builds both images on every PR. Run it locally only if CI's image build fails and you need to debug it."
   - Fix the E2E command line: `APP_ENV` is set in `playwright.config.ts`; the run needs `DATABASE_URL` and the Docker services.
4. **Docs:** technical 07 (CI jobs), 09; `docs/CHEATSHEET.md` only if it lists CI jobs.

## Must not touch

- `.github/workflows/deploy.yml` and its cache scopes; the Dockerfiles; `.kamal/secrets*`.
- No local `docker build` for this task.

## Acceptance

- [ ] Plan approved before the change.
- [ ] `ci.yml` parses; the job has no `needs`, the two matrix entries and the two cache scopes.
- [ ] First run on the PR: "Image build (web)" and "Image build (indexer)" green.
- [ ] **Deliberate red run (David):** one throwaway commit on the PR reintroduces the `./e2e` import in `apps/web/playwright.config.ts`; "Image build (web)" must go red; the commit is then reverted. The exact commit is described in the feedback under "Steps for David".
- [ ] Measured run times (cold and warm) written into the feedback in the second pass.
- [ ] Docs updated; feedback names the chapters.

## Suggested commit message

- `ci: build the web and indexer images on every PR (TASK-028)`

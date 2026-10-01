# TASK-026 — Indexer deploy (dev)

Read first: `docs/tasks/TASK-006-ponder-indexer.md` and `TASK-006.feedback.md`, ADR-020, ADR-021, ADR-026, `docs/02-ARCHITECTURE.md` §5 (memory budget, environments), `infra/shared/compose.yml`, `infra/shared/ensure-databases.sh`, `config/deploy*.yml`, `.github/workflows/deploy.yml`, `Dockerfile`, `docs/CHEATSHEET.md`.

## Goal
The Ponder indexer from TASK-006 runs on the dev server, indexes the amoy-dev contracts from their `startBlock`, survives restarts and redeploys, and the web app's database role can read the `chain.*` views. uat and prod get the same shape later by adding a destination file and secrets — no code change.

## Scope

### 1. Database role and connection budget (infra as code)
- `infra/shared/ensure-databases.sh` (idempotent) creates role `cherrio_indexer_dev` with `LOGIN`, its own `CONNECTION LIMIT 10`, and password from `infra.env` → `POSTGRES_INDEXER_DEV_PASSWORD`. Prepare the same for uat/prod (roles created only when their password variable is set; missing variable = skipped with a log line, not an error).
- Privileges: `CONNECT` on `cherrio_dev`; `CREATE` on database `cherrio_dev` (Ponder creates `chain_<sha7>`, `chain`, `ponder_sync`); **no** privileges on schema `app`. Verify with a query that `cherrio_indexer_dev` cannot select from or write to any `app.*` table.
- The web role `cherrio_dev` must be able to `SELECT` from every view in schema `chain`, also after a redeploy recreates the views. Design how (schema ownership + default privileges, or a grant step in the deploy job) and prove it after two consecutive deploys.
- Connection budget: today `cherrio_dev` has `CONNECTION LIMIT 20` and PgBouncer `default_pool_size = 20`; Postgres `max_connections = 100` for all three envs. Propose the numbers (e.g. PgBouncer pool 15 per env, indexer limit 10 per env, Ponder `poolConfig.max` 8) and write a budget table into `infra/README.md`. The total for dev + uat + prod plus superuser/backup headroom must stay ≤ 90.
- David applies infra changes on the server (`infra/sync.sh` + `sudo bash … ensure-databases.sh`); the agent only writes and dry-runs them.

### 2. Image
- `Dockerfile.indexer` (repo root context, same `.dockerignore`): multi-stage, Node 22 alpine, pnpm, only the workspace packages the indexer needs, non-root user, no dev dependencies in the runner, no source maps or test files.
- The image runs `ponder start --schema chain_${GIT_SHA7} --views-schema chain`; `GIT_SHA7` is passed at build time or as env by Kamal.
- `scripts/reconcile.ts` is runnable inside the image (`node … reconcile` or `pnpm`-free equivalent).
- Built only in GitHub Actions, pushed to GHCR as `ghcr.io/datavallis-cherr-io/cherrio/indexer:sha-xxxxxxx`.

### 3. Kamal service
- A separate Kamal service for the indexer (separate config file + destination files, e.g. `config/indexer.yml` + `config/indexer.dev.yml`), service name `cherrio-indexer-dev`.
- No proxy route and no published ports. Reachable only on the `kamal` Docker network (the web app may call `/sql` or `/graphql` internally later).
- Memory limit 384 MB, `NODE_OPTIONS=--max-old-space-size=288` (Architecture §5 budget). Report real memory after a full backfill (`docker stats --no-stream`).
- Env: `APP_ENV=dev` (clear); secrets `PONDER_RPC_URL_80002` and `DATABASE_URL_DIRECT` for the **indexer role** (direct Postgres `cherrio-infra-postgres-1:5432`, never PgBouncer). Secret names in GitHub Environment `dev`: `PONDER_RPC_URL_80002`, `INDEXER_DATABASE_URL`.
- Container health check on Ponder `/health`. Readiness (`/ready`) is checked by the deploy job, not by Docker.

### 4. Deploy job
- `.github/workflows/deploy.yml`: build + push the indexer image and deploy `cherrio-indexer-<env>` on push to `dev` (and `uat` once its destination exists). The web deploy must not wait for indexer backfill.
- After deploy: wait for `/ready` (inside the server network, e.g. `kamal app exec` or `docker exec … wget`) with a timeout; on timeout the job fails and prints the last 100 log lines.
- Then run reconcile against dev inside the new container; non-zero mismatches fail the job.
- Then prune: remove `chain_<sha>` schemas that are no longer used (`ponder db prune` or equivalent), keeping the live one and one previous. Never touch `app`, `ponder_sync`, or `chain`.
- Rollback: document how to point back to the previous image (`kamal rollback` for the indexer service) and what happens to the views.

### 5. Tests that PR #16 left out
- Extend the scenario with the allocation outcomes `REJECTED`, `RESOLVED_REJECT`, and a `DELIVERY_FAILED` reached through `resolveAllocation`; reconcile stays at zero mismatches.

### 6. Docs (agent may edit these files for this task)
- `docs/CHEATSHEET.md`: new section "Indexer" — logs, status/ready, reconcile on dev, re-index from scratch, prune, rollback, memory check, the read-only check for the web role.
- `infra/README.md`: connection budget table and the new role.
- `docs/tasks/TASK-026.feedback.md`.

## Must not touch
`packages/contracts/src/**`, `packages/db/**` (app schema), `apps/web/**` except reading views in a test if needed, the existing web Kamal service configuration beyond what is needed for coexistence.

## Acceptance criteria
- dev indexer is running, `/ready` reached, `chain.pool` contains pool 0, reconcile reports 0 mismatches against amoy-dev at the indexed block.
- A second deploy creates a new `chain_<sha7>`, the `chain` views switch to it, the web role can still read them, the previous schema is kept, older ones are pruned.
- `cherrio_indexer_dev` cannot read or write `app.*` (shown with the denied query output).
- Connection budget table in `infra/README.md`; real `pg_stat_activity` counts per role after deploy.
- Memory after full backfill below the limit (real `docker stats` line).
- No published port: `docker port cherrio-indexer-dev-…` is empty; `https://dev.cherr.io/sql` returns the web app's 404.
- Scenario test green with the three extra allocation outcomes; CI green.
- Feedback lists everything NOT RUN and every manual step David performed on the server.

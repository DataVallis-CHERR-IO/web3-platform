# TASK-022 Feedback — App deployment pipeline (web)

## Status: DONE (awaiting David's server setup + GitHub config)

## Files changed

| File | Action | Purpose |
|---|---|---|
| `Dockerfile` | Created | Multi-stage standalone Next.js build |
| `.dockerignore` | Created | Slim Docker context |
| `apps/web/next.config.mjs` | Modified | Added `output: "standalone"` |
| `apps/web/src/middleware.ts` | Modified | Excludes `/api`; adds `X-Robots-Tag: noindex, nofollow` on non-prod |
| `apps/web/src/app/api/health/route.ts` | Created | Health endpoint for Kamal proxy |
| `apps/web/src/app/robots.txt/route.ts` | Created | Dynamic robots.txt (disallow on non-prod) |
| `.github/workflows/deploy.yml` | Created | CI/CD: build → deploy → migrate → smoke test |
| `config/deploy.yml` | Modified | Base Kamal config — web only, `registry.username` as secret |
| `config/deploy.dev.yml` | Modified | Dev destination — web only, `servers.web.hosts/options` |
| `config/deploy.uat.yml` | Modified | UAT destination — web only |
| `config/deploy.prod.yml` | Modified | Prod destination — web only, workflow_dispatch only |
| `.kamal/secrets` | Created | Env-var references for Kamal (no values committed) |

## Kamal config validation

Validated with Kamal 2.12.0 (`kamal config -d dev` and `-d uat`):

```
:repository: ghcr.io/datavallis-cherr-io/cherrio/web
:service_with_version: cherrio-web-dev-<sha>
:roles: [web]
:hosts: [49.13.63.71]
```

## GitHub setup checklist

### 1. Environments

Create three GitHub Environments: **dev**, **uat**, **prod**.
Set **prod** to require branch `main` for deployment.

### 2. Secrets per environment

| Secret | dev | uat | prod | Notes |
|---|---|---|---|---|
| `SSH_PRIVATE_KEY` | ✓ | ✓ | ✓ | Ed25519 key for `deploy@49.13.63.71` |
| `SSH_KNOWN_HOSTS` | ✓ | ✓ | ✓ | Output of `ssh-keyscan 49.13.63.71` |
| `KAMAL_REGISTRY_USERNAME` | ✓ | ✓ | ✓ | GitHub user who owns the PAT below |
| `KAMAL_REGISTRY_PASSWORD` | ✓ | ✓ | ✓ | GitHub PAT with `read:packages` scope |
| `DATABASE_URL` | ✓ | ✓ | ✓ | PgBouncer URL (port 6432) |
| `DATABASE_URL_DIRECT` | ✓ | ✓ | ✓ | Direct Postgres URL (port 5432) |

`KAMAL_REGISTRY_PASSWORD` is used ONLY in `registry.password` — it is NOT in
`env.secret` and never reaches app containers.

### 3. Variables per environment

| Variable | dev | uat | prod |
|---|---|---|---|
| `APP_ENV` | `dev` | `uat` | `prod` |
| `HOST` | `dev.cherr.io` | `uat.cherr.io` | `cherr.io` |

### 4. Repository permissions

The workflow uses `GITHUB_TOKEN` with `packages: write` to push images to GHCR.
No extra PAT needed for the image push step.

## DNS records (create now)

| Record | Type | Value |
|---|---|---|
| `dev.cherr.io` | A | `49.13.63.71` |
| `uat.cherr.io` | A | `49.13.63.71` |

Prod DNS (`cherr.io`, `app.cherr.io`, `api.cherr.io`) deferred until go-live.

## Server commands (run as deploy@49.13.63.71)

```bash
# 1. Ensure the kamal network exists (Kamal creates it on first deploy,
#    but infra compose needs it first)
docker network create kamal 2>/dev/null; echo "kamal network ready"

# 2. Reconnect infra services to the kamal network
cd /opt/cherrio/infra/shared
docker compose --env-file /opt/cherrio/secrets/infra.env down
docker compose --env-file /opt/cherrio/secrets/infra.env up -d

# 3. Verify Postgres and PgBouncer are on the kamal network
docker network inspect kamal --format '{{range .Containers}}{{.Name}} {{end}}'
# Should list: cherrio-infra-postgres-1, cherrio-infra-pgbouncer-1, ...
```

No `docker login` needed on the server — Kamal handles registry auth on every
deploy using `KAMAL_REGISTRY_USERNAME` + `KAMAL_REGISTRY_PASSWORD`.

## Connection strings

| Env | DATABASE_URL | DATABASE_URL_DIRECT |
|---|---|---|
| dev | `postgres://cherrio_dev:<pw>@cherrio-infra-pgbouncer-1:6432/cherrio_dev` | `postgres://cherrio_dev:<pw>@cherrio-infra-postgres-1:5432/cherrio_dev` |
| uat | `postgres://cherrio_uat:<pw>@cherrio-infra-pgbouncer-1:6432/cherrio_uat` | `postgres://cherrio_uat:<pw>@cherrio-infra-postgres-1:5432/cherrio_uat` |
| prod | `postgres://cherrio_prod:<pw>@cherrio-infra-pgbouncer-1:6432/cherrio_prod` | `postgres://cherrio_prod:<pw>@cherrio-infra-postgres-1:5432/cherrio_prod` |

Service DNS names (`cherrio-infra-postgres-1`, `cherrio-infra-pgbouncer-1`) resolve
on the `kamal` Docker network. Both compose services already join this network.

## Why migrations run AFTER deploy, not before

### The problem with `kamal app exec` before first deploy

`kamal app exec --version X` runs `docker run ... --env-file <path> ...` on the
remote host. The env file (e.g. `.kamal/apps/cherrio-web-dev/env/roles/web.env`)
is uploaded to the host only during `kamal deploy` → `app boot`:

```ruby
# lib/kamal/cli/app/boot.rb (Kamal 2.12.0), start_new_version:
execute *app.ensure_env_directory
upload! role.secrets_io(host), role.secrets_path, mode: "0600"
execute *app.run(hostname: hostname)
```

There is no standalone `kamal env push` in Kamal 2 (removed since v1.x). The
`--push-secrets` flag is an unmerged PR (#1742, opened Dec 2025).

Running `kamal app exec` before the first deploy fails with:
```
docker: open .kamal/apps/cherrio-web-dev/env/roles/web.env: no such file or directory
```

See: https://github.com/basecamp/kamal/issues/1180

### The solution: deploy → migrate

The workflow order is:

1. Build image, push to GHCR
2. `kamal deploy -d <env> --skip-push --version sha-<7chars>` — boots containers,
   uploads env files, healthchecks `/api/health`, swaps traffic
3. `kamal app exec -d <env> --version sha-<7chars> --primary "node packages/db/dist/migrate.mjs"`
   — env file now exists on host

This is safe because Architecture §5.3 mandates backward-compatible migrations
(expand/migrate/contract). The new code is designed to work with both old and new
schema. The health endpoint (`/api/health`) does not query the database, so Kamal's
healthcheck passes even before migrations run.

If the migration step fails, the workflow fails and the operator is alerted. The app
is already running with the new code against the old schema (which works by design).
Rollback with `kamal rollback -d <env> sha-<previous>` if needed.

## How deploy works

1. Push to `dev` or `uat` branch → GitHub Actions triggers `deploy.yml`
2. Builds Docker image, pushes to GHCR with tag `sha-<7chars>`
3. `kamal deploy -d <env> --skip-push --version sha-<7chars>` — Kamal pulls image,
   uploads env files, boots container, healthchecks `/api/health`, swaps traffic
4. `kamal app exec -d <env> --version ... --primary "node packages/db/dist/migrate.mjs"`
   — runs migration using `DATABASE_URL_DIRECT` (direct Postgres, not PgBouncer)
5. Smoke tests: `/api/health` (sha match), `/en` (200), `/en/dev/ui` (200 on dev,
   404 on uat/prod)
6. Prod: only via `workflow_dispatch` → creates release tag `vYYYY.MM.DD-<sha>`

If migration fails → workflow fails → operator rolls back or fixes forward.

## How to verify

```bash
# After first deploy to dev:
curl -sf https://dev.cherr.io/api/health
# → {"status":"ok","env":"dev","sha":"<sha>","timestamp":"..."}

curl -sf https://dev.cherr.io/en -o /dev/null -w "%{http_code}"
# → 200

curl -sI https://dev.cherr.io/en | grep -i x-robots-tag
# → X-Robots-Tag: noindex, nofollow

curl -sf https://dev.cherr.io/robots.txt
# → User-agent: *\nDisallow: /
```

## How to roll back

```bash
# Find the previous image tag:
kamal app containers -d dev
# Roll back:
kamal rollback -d dev sha-<previous>
```

## Migration runner: esbuild bundle

The Next.js standalone output traces only `apps/web` dependencies. `drizzle-orm`
and `postgres` are dependencies of `@cherrio/db`, not `apps/web`, so they are
NOT included in the standalone `node_modules`.

**Fix**: The Dockerfile builder stage bundles `packages/db/src/migrate.ts` into a
single self-contained `packages/db/dist/migrate.mjs` using esbuild. All
dependencies (`drizzle-orm`, `postgres`, `uuid`) are inlined. The runner stage
copies only this one file plus `packages/db/drizzle/` (SQL migration files).

```dockerfile
# In builder stage:
RUN pnpm --filter @cherrio/db exec esbuild packages/db/src/migrate.ts \
      --bundle --platform=node --target=node22 --format=esm \
      --outfile=packages/db/dist/migrate.mjs \
      --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"
```

The bundle resolves the migrations folder via `join(__dirname, "../drizzle")`:
- Bundle at `/app/packages/db/dist/migrate.mjs` → `__dirname` = `/app/packages/db/dist/`
- `../drizzle` → `/app/packages/db/drizzle/` ✓

Workflow command: `node packages/db/dist/migrate.mjs`

## Scope limits

- Web app only — no indexer, worker, MCP, or Redis (arrive in TASK-006+)
- No Privy, Sumsub, Transak, storage secrets (arrive with their respective tasks)
- Prod deploy is manual-only (workflow_dispatch) until go-live
- Prod DNS deferred until go-live

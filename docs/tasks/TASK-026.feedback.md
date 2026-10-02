# TASK-026 feedback — Indexer deploy (dev)
Status: DONE

Everything is written and proven locally with the real image against a local chain and Postgres. Nothing has run on the server or in GitHub Actions yet: every acceptance criterion that names the dev server is still open and listed under NOT RUN. The task is DONE when David has performed the server steps below and the outputs are pasted here.

## What I implemented
- **Role and budget:** `infra/shared/indexer-role.sql` (new) and `ensure-databases.sh` create `cherrio_indexer_<env>` when `POSTGRES_INDEXER_<ENV>_PASSWORD` is set (otherwise a log line, no error). Web role limit 18 (new for prod), PgBouncer pool 14, reserve 2, indexer limit 10, Ponder `poolConfig.max` 5. `ensure-databases.sh` got `--dry-run`.
- **Image:** `Dockerfile.indexer` — Node 22 alpine, production dependencies only, non-root, `HEALTHCHECK` on `/health`, command `ponder start --schema chain_${GIT_SHA7} --views-schema chain`, `dist/reconcile.mjs` and `dist/prune.mjs` runnable with plain `node`.
- **Kamal service:** `config/indexer.yml` + `config/indexer.dev.yml`, service `cherrio-indexer-dev`, no proxy, no published port, 384 MB, network alias `cherrio-indexer-dev`.
- **Deploy job:** jobs `indexer-changes` (path filter + `workflow_dispatch`) and `indexer` in `deploy.yml`: build → Kamal deploy → wait for `/ready` (20 min) → reconcile → prune. Independent of the web job.
- **Prune:** `lib/prune.ts` + `scripts/prune.ts`, own implementation.
- **Scenario:** allocation outcomes `REJECTED`, `RESOLVED_REJECT`, and `DELIVERY_FAILED` through `resolveAllocation`.
- **Docs:** cheat sheet §10 "Indexer", `infra/README.md` budget table and role.

## Findings that changed the design
- **`ponder db prune` is not used.** It drops every schema whose instance has stopped, including the previous one. The own script keeps the schema the `chain` views read from (found through view dependencies, not names) and the most recent other one, treats any instance with a heartbeat younger than 2 minutes as running, and can only drop names matching `chain_<id>`.
- **Ponder does not drop or recreate schema `chain`.** The schema's oid stayed the same across three local deploys, so owner, `USAGE` and default privileges survive. No grant step is needed in the deploy job.
- **Kamal 2.12 start/stop order without a proxy:** it starts the new container, waits until Docker reports it `healthy` (or `running` when the image has no health check), then stops the old one. Source: installed gem `kamal-2.12.0`, `lib/kamal/cli/app/boot.rb` (`run`: `start_new_version` then `stop_old_version`; `start_new_version` calls `Healthcheck::Poller.wait_for_healthy` when `running_proxy?` is false) and `lib/kamal/cli/healthcheck/poller.rb`.
- **So two versions overlap during a deploy.** Measured locally with `poolConfig.max: 5`: one instance peaks at 5 connections and idles at 2; old + new together peaked at 7 of the role's 10. The theoretical worst case is 12 (2 × (5 + 1 LISTEN)); the cheat sheet has the fallback.
- **`/ready` means "backfill reached the finalized block".** The last ~30 blocks are processed right after. Reconcile compares at the indexed block, so running it immediately after `/ready` is correct.
- **A stopped Ponder instance keeps `is_locked = 1`** in its meta table, so prune uses the heartbeat age, not the lock flag.

## Local proof (real outputs, this session)
Temporary objects in the local `docker-compose.dev.yml` Postgres, all dropped afterwards: roles `tmp_t26_web`, `tmp_t26_indexer`; database `cherrio_t26`. Final check: `tmp roles left: 0`, `test dbs left: 0`.

Indexer role against `app.*`:
```
$ select * from app.users
ERROR:  permission denied for schema app
$ insert into app.users values (2,'x')
ERROR:  permission denied for schema app
$ update app.users set email='x'
ERROR:  permission denied for schema app
$ delete from app.users
ERROR:  permission denied for schema app
$ create table app.evil (id int)
ERROR:  permission denied for schema app
$ drop schema app cascade
ERROR:  must be owner of schema app
```
`indexer-role.sql` twice: both runs exit 0 (second run: `schema "chain" already exists, skipping`). Roles: `tmp_t26_indexer|10|f|f`, `tmp_t26_web|18|f|f` (limit, superuser, createdb).

Three consecutive deploys of the image (`GIT_SHA7` aaa0001 → bbb0002 → ccc0003), state after the third:
```
schemas: app(tmp_t26_web) chain(tmp_t26_indexer) chain_aaa0001(tmp_t26_indexer) chain_bbb0002(tmp_t26_indexer) chain_ccc0003(tmp_t26_indexer) ponder_sync(tmp_t26_indexer)
schema chain oid: 36035          (same oid after every deploy)
views read from: chain_ccc0003
web role: select from chain.pool        → 0:200000000:200000000
web role: select from chain.campaign    → LIVE:300000000
web role: views it can read / all views → 15 / 15
web role: write to a view               → ERROR:  permission denied for view pool
web role: read chain_<sha> directly     → ERROR:  permission denied for schema chain_ccc0003
web role: read ponder_sync              → ERROR:  permission denied for schema ponder_sync
```
Prune and reconcile inside the container:
```
prune (dry run): live=chain_ccc0003 kept=[chain_bbb0002] would drop=[chain_aaa0001]
prune: live=chain_ccc0003 kept=[chain_bbb0002] dropped=[chain_aaa0001]
reconcile: schema=chain block=7 checked=37 mismatches: 0
```
Restart of the same version: `Detected crash recovery build_id=10f505f6d6 last_active=25ss schema=chain_ccc0003`, `/ready` after ~16 s.
Rollback (start bbb0002 again): `Detected crash recovery … schema=chain_bbb0002`, then `views read from: chain_bbb0002`.

Container facts: `docker port` printed nothing; `health=healthy user=indexer`; `uid=1001(indexer)`; `node_modules/.bin` contains only `ponder`; no `*.map` or `*.test.ts` files; image size 563 MB.
Memory (tiny local chain, not a real backfill): `161.7MiB / 384MiB (42.12%)`.
Connections with the shipped `poolConfig.max: 5`: `peak … first deploy (one instance): 5`, `peak … second deploy (old + new overlap): 7`, idle `tmp_t26_indexer=2`.

Kamal config, validated with the installed gem and stub secrets in a scratch directory: `running_proxy=false`, `proxy hosts=[]`, and the generated `docker run` has `--network kamal`, `--memory "384m"`, `--network-alias "cherrio-indexer-dev"`, no `--publish`; secret env keys `PONDER_RPC_URL_80002, DATABASE_URL_DIRECT`.

`ensure-databases.sh --dry-run` with a stub env file: exit 0, passwords printed as `***` (0 occurrences of the stub values), uat/prod indexer roles skipped with a log line, PgBouncer config shows `default_pool_size = 14`, `reserve_pool_size = 2`.

## Files changed
- `Dockerfile.indexer` — new
- `config/indexer.yml`, `config/indexer.dev.yml` — new
- `.github/workflows/deploy.yml` — jobs `indexer-changes`, `indexer`
- `infra/shared/indexer-role.sql` — new
- `infra/shared/ensure-databases.sh` — `--dry-run`, indexer roles, limits, PgBouncer pool sizes
- `infra/README.md` — roles and connection budget
- `apps/indexer/lib/prune.ts`, `scripts/prune.ts`, `test/prune.test.ts` — new
- `apps/indexer/test/scenario.test.ts` — three allocation outcomes
- `apps/indexer/ponder.config.ts` — `poolConfig.max` 8 → 5
- `apps/indexer/package.json` — `prune` script, `test:scenario` also runs the prune test, `esbuild`
- `pnpm-lock.yaml`
- `docs/CHEATSHEET.md` — §10, secrets row, open items
- `docs/tasks/TASK-026.feedback.md`

## Deviations from the task (and why)
- Own prune script instead of `ponder db prune` (see findings).
- No grant step in the deploy job: default privileges on the pre-created schema `chain` are enough (proven above).
- `GIT_SHA7` is a build argument baked into the image, not a Kamal env value, so a rollback to an older image uses that image's schema automatically.
- The indexer job is skipped for an environment without `config/indexer.<env>.yml` (uat, prod today) instead of failing.
- Path filter implemented with `git diff` in the workflow, without a third-party action.
- `ensure-databases.sh` also sets a connection limit on `cherrio_prod` and lowers the PgBouncer pool for all environments (accepted budget).
- Size: about 850 lines without the lockfile and this file.

## New dependencies
- `esbuild@^0.28.2` (dev, indexer) — bundles reconcile and prune for the image; same version `packages/db` already uses.

## How to verify
Local:
1. `export DATABASE_URL_DIRECT=postgres://cherrio:cherrio@127.0.0.1:5432/cherrio_dev`
2. `pnpm --filter indexer test` → 15 passed; `pnpm --filter indexer test:scenario` → 18 passed.
3. `docker build -f Dockerfile.indexer --build-arg GIT_SHA7=abc1234 -t cherrio-indexer:local .`
4. `bash infra/shared/ensure-databases.sh --dry-run <stub env file>`

Server: see "Server steps for David" below and cheat sheet §10.

## Test results
- `pnpm --filter indexer test:scenario`: 2 files, 18 tests passed (scenario 11, prune 7). Reconcile `block=112 checked=398 mismatches: 0`; corrupted row: 1 mismatch, exit 1.
- Scenario now has 7 allocations: PASSED ×2, DELIVERY_FAILED via close, RESOLVED_PASS, REJECTED, RESOLVED_REJECT, DELIVERY_FAILED via resolve. Pool 7 still ends at 500 USDC.
- `pnpm --filter indexer test`: 3 files, 15 tests passed.
- Deliberate failure (prune): planning no longer skipped the live schema → 4 of 7 prune tests failed, and the second guard still refused: `Refusing to drop schema "chain_aaa0001"`. Restored → 7 passed.
- `pnpm --filter='!@cherrio/contracts' lint` and `typecheck`: every project that has the script reports Done (7 lines), no errors.
- `docker build -f Dockerfile.indexer`: succeeded.

## NOT RUN
- Anything on the server: `ensure-databases.sh` (real run), the first and second deploy, `/ready` on dev, reconcile against amoy-dev, `chain.pool` on dev, prune on dev — NOT RUN (David applies; the agent has no server access).
- GitHub Actions: the `indexer-changes` and `indexer` jobs — NOT RUN. The workflow parses as YAML and the path filter expression was exercised locally with 14 sample paths.
- `kamal deploy` / `kamal app exec` / `kamal rollback` — NOT RUN; only the configuration was loaded with the gem.
- Memory after a full backfill of real Amoy — NOT RUN (local figure is for a 7-block chain).
- `pg_stat_activity` per role on the server — NOT RUN.
- `docker port` on the server and `https://dev.cherr.io/sql` → 404 — NOT RUN.
- The check that `cherrio_indexer_dev` cannot connect to `cherrio_uat` / `cherrio_prod` — NOT RUN; it depends on `REVOKE CONNECT … FROM PUBLIC`, which the local database does not have.
- CI ("Indexer scenario" job with the new tests) — NOT RUN until pushed.
- `pnpm --filter web test`, `forge test`, `next build`, e2e — NOT RUN (no file of theirs changed).

## Server steps for David (in order)
1. Create the indexer password; add `POSTGRES_INDEXER_DEV_PASSWORD=…` to `/opt/cherrio/secrets/infra.env` on the server.
2. Mac: `bash infra/sync.sh --live`
3. Server: `sudo bash /opt/cherrio/infra/shared/ensure-databases.sh --dry-run` and read the output.
4. Server: `sudo bash /opt/cherrio/infra/shared/ensure-databases.sh` — restarts PgBouncer, all environments reconnect. Then `curl -s https://dev.cherr.io/api/health` must show `"db":"ok"`.
5. GitHub Environment `dev`: add secrets `PONDER_RPC_URL_80002` and `INDEXER_DATABASE_URL` (format in cheat sheet §10.1).
6. Add to `.kamal/secrets-common`:
   ```
   PONDER_RPC_URL_80002=$PONDER_RPC_URL_80002
   INDEXER_DATABASE_URL=$INDEXER_DATABASE_URL
   ```
7. Commit, PR, merge to `dev`; watch the job "Indexer — Build → Deploy → Ready → Reconcile → Prune".
8. Server: run the checks of cheat sheet §10.2 and §10.3 and paste the outputs below (ready, reconcile, `chain.pool`, denied `app.*` query, web-role select, `pg_stat_activity`, `docker stats`, `docker port`), plus `curl -s -o /dev/null -w '%{http_code}' https://dev.cherr.io/sql`.
9. Second deploy: Actions → Deploy → Run workflow → dev on a later commit that touches the indexer inputs; then repeat the schema and web-role checks (new `chain_<sha7>`, views switched, previous schema kept).

### Manual steps performed on the server
- 2026-10-02, David, as `deploy` on the dev server: the read-only checks of cheat sheet §10.2 and §10.3. Outputs: "Server results (TASK-027)" below.
- Setup steps 1–6 above (role password in `infra.env`, `infra/sync.sh`, `ensure-databases.sh` dry run and real run, GitHub secrets, `.kamal/secrets-common`): NOT RUN — not provided. No output of these steps was given to the implementer. That they were carried out is inferred only from the result: the indexer deployed (Deploy runs 36923510353 and 36973809232) and role `cherrio_indexer_dev` owns the schemas shown below.

## Open questions / risks
- Deploy overlap can in theory need 12 connections against a limit of 10; 7 were measured. Fallback is in cheat sheet §10.4.
- While a new version backfills, readers see the previous schema; after a failed boot Kamal keeps the old version running.
- Reconcile in the deploy job makes a few hundred RPC calls per run; it grows with the number of campaigns.
- Ponder at 384 MB is unproven on a real backfill.
- The image is 563 MB (Ponder and its dependencies).
- A 20-minute `/ready` timeout is a guess until the first real backfill is timed.

## Suggested commit message
feat(indexer): deploy the Ponder indexer to dev as its own Kamal service (TASK-026)

## Server results (TASK-027)

Outputs provided by David on 2026-10-02 and written here verbatim. The server address was already replaced with `<server>` in what he provided.

GitHub Actions — Deploy run 36973809232 on dev (merge of PR #18, commit 31a0a61), job "Indexer — Build → Deploy → Ready → Reconcile → Prune": all steps success.

Step "Reconcile against the chain":
```
  INFO [395db37b] Running docker exec cherrio-indexer-dev-indexer-dev-sha-31a0a61 node dist/reconcile.mjs on <server>
  INFO [395db37b] Finished in 0.873 seconds with exit status 0 (successful).
App Host: <server>
reconcile: schema=chain block=49100332 checked=4 mismatches: 0
```

Step "Prune old schemas":
```
  INFO [a073d392] Running docker exec cherrio-indexer-dev-indexer-dev-sha-31a0a61 node dist/prune.mjs on <server>
  INFO [a073d392] Finished in 0.691 seconds with exit status 0 (successful).
App Host: <server>
prune: live=chain_31a0a61 kept=[chain_d991cb3] dropped=[]
```

Server (deploy@cherrio-1), 2026-10-02:
```
== status
{"cherrio":{"id":80002,"block":{"number":49101007,"timestamp":1790923434}}}
== ready
  HTTP/1.1 200 OK
== reconcile
reconcile: schema=chain block=49101007 checked=4 mismatches: 0
== schemas
    nspname    |   pg_get_userbyid   
---------------+---------------------
 chain         | cherrio_indexer_dev
 chain_d991cb3 | cherrio_indexer_dev
 ponder_sync   | cherrio_indexer_dev
 chain_31a0a61 | cherrio_indexer_dev
(4 rows)
== web role read
SET
 count 
-------
     0
(1 row)
== web role write
ERROR:  permission denied for view pool
SET
== indexer role on app
SET
ERROR:  permission denied for schema app
LINE 1: set role cherrio_indexer_dev; select * from app.users limit ...
                                                    ^
== connections
       usename       | count 
---------------------+-------
 cherrio_dev         |     2
 cherrio_indexer_dev |     5
 cherrio_prod        |     2
 cherrio_uat         |     2
(4 rows)
== stats
CONTAINER ID   NAME                                          CPU %     MEM USAGE / LIMIT   MEM %     NET I/O           BLOCK I/O     PIDS
8f7625e87ef6   cherrio-indexer-dev-indexer-dev-sha-31a0a61   4.46%     165.1MiB / 384MiB   42.98%    2.07MB / 2.04MB   0B / 45.1kB   18
== port (must be empty)
== /sql from outside
404
== masked lines (count of "/v2/***" in the last 500 log lines)
0
== key check (count of the first characters of the real key in the last 500 log lines; run by David, key not shown)
0
```

Notes from David: `chain.campaign` count 0 is expected — no campaign exists on amoy-dev yet; the 4 reconciled values are Emergency Pool state. "masked lines 0" means no RPC error occurred since the deploy, so the masking was not exercised on the server; it is proven by the tests (TASK-027 first pass).

### Checks against the expected results

| Check | Expected | Result |
|---|---|---|
| Deploy job prune | `live=chain_<new sha7>`, `kept=[chain_d991cb3]` | matches (`live=chain_31a0a61`) |
| `/ready` | `HTTP/1.1 200` | matches |
| Reconcile (deploy job and on the server) | 0 mismatches | matches |
| Schemas | new `chain_<sha7>`, previous kept, `chain`, `ponder_sync`, all owned by the indexer role | matches |
| Web role | can read `chain.campaign`, cannot update `chain.pool` | matches |
| Indexer role on `app` | `permission denied for schema app` | matches |
| Connections per role | web ≤ 18, indexer ≤ 10 | matches (2 and 5) |
| Memory | below 384 MiB | 165.1 MiB, measured after the deploy at idle, not during a backfill |
| `docker port` | empty | matches |
| `https://dev.cherr.io/sql` | 404 | matches |
| Key in the last 500 log lines | 0 | matches |

NOT RUN — not provided:
- Memory during a full backfill.
- `chain.pool` contents on dev (the acceptance line "contains pool 0"); only the reconcile line is available.
- The check that `cherrio_indexer_dev` cannot connect to `cherrio_uat` / `cherrio_prod`.
- Outputs of `ensure-databases.sh` (dry run and real run) on the server.

## Correction (TASK-027, 2026-10-02)

This file is kept as written on the day of TASK-026. These statements are outdated:

- **Opening paragraph and "NOT RUN":** the server and GitHub Actions items listed as not run have since been run; see "Server results (TASK-027)". The four items listed there as not provided are the only ones still open.
- **Server step 9:** "Actions → Deploy → Run workflow" is not available: GitHub shows that button only when `deploy.yml` is on the default branch `main`. A second deploy is triggered by a commit that changes an indexer input; that is how the second deploy above (PR #18) happened. Current wording: `docs/CHEATSHEET.md` §10.
- **Pruning:** recorded as ADR-029.

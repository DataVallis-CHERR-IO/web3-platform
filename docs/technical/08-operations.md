# 08 — Operations

A short operator guide for CHERR.IO. It summarises the day-to-day procedures and points to the exact section of `docs/CHEATSHEET.md` (the authoritative, step-by-step operator sheet) or `infra/README.md` for each one: health checks, logs, deploy and rollback, migrations, granting admin, indexer operations, backups and restore, monitoring access through an SSH tunnel, and an incident checklist built from problems that actually occurred during setup (failed logins, deploy SSH resets, PgBouncer authentication errors, Docker issues). This guide contains no secrets and no server address: secrets live in the password manager, `/opt/cherrio/secrets/infra.env` (mode 600) or GitHub; the server address is in the cheat sheet. Below, `<server>` stands for it.

Last updated: 2026-10-01

Status: dev web app **Live on dev**; indexer **Built** (first server deploy pending, TASK-026); uat and prod **not deployed**.

> Tips from the cheat sheet: log in first with `ssh deploy@<server>`, then paste multi-line commands (a pasted first line `ssh …` swallows the rest). Never paste secrets into chat.

---

## 1. Health checks

| Check | How | Expect |
|---|---|---|
| App health | `curl -s https://dev.cherr.io/api/health` | `200 {"status":"ok","db":"ok","env":"dev","sha":…}` |
| Health error codes | `auth_config_error` (500), `db_config_error` (503), `db_unreachable` (503) — Kamal keeps the previous container | see cheat sheet §1 table |
| Containers | `docker ps --format 'table {{.Names}}\t{{.Status}}'` | infra services `Up (healthy)` |
| Resources | `docker stats --no-stream`, `free -h && df -h /` | within memory limits |
| No public DB port | `ss -tlnp \| grep 5432` | `127.0.0.1:5432` only |
| Indexer | `/status`, `/ready` inside the container | `/ready` 200 after backfill |

Details: `docs/CHEATSHEET.md` §1 (health and paths), §2 (common commands), §10.2 (indexer).

## 2. Logs

- Web app: `docker logs -f --tail 100 $(docker ps -qf name=cherrio-web-dev)` (cheat sheet §2).
- Indexer: `docker logs -f --tail 100 $(docker ps -qf name=cherrio-indexer-dev)` (§10.2).
- PgBouncer: `docker logs --since 2m cherrio-infra-pgbouncer-1 2>&1 | tail -20` (§3).
- Backups: `journalctl -u cherrio-backup --since today` (§5).
- Centralised: Grafana → Loki data source (7-day retention), see §8 below.

## 3. Deploy and rollback

| Action | How | Reference |
|---|---|---|
| Deploy dev / uat | Merge PR into `dev` / `uat` → "Deploy" workflow runs automatically | cheat sheet §6 |
| Deploy prod | Actions → Deploy → Run workflow → `prod` (manual only; not live yet) | cheat sheet §6 |
| Redeploy / force indexer | Actions → Deploy → Run workflow → env | cheat sheet §6, §10 |
| Roll back web | Re-run "Deploy" for the last good commit, or on the Mac with env vars exported: `kamal rollback -d dev sha-<good>` | cheat sheet §6 |
| Roll back indexer | `kamal rollback -c config/indexer.yml -d dev sha-<previous>` (one version back resumes; further = full re-index) | cheat sheet §10.4 |

A deploy is only marked healthy when `/api/health` passes (auth env + `select 1` through PgBouncer) and the smoke tests (`/api/health` SHA, `/en`, `/en/dev/ui`) pass. See `07-delivery-and-quality.md` §4.

## 4. Migrations

- Run automatically by the deploy workflow **after** `kamal deploy`: `kamal app exec -d <env> --primary "node packages/db/dist/migrate.mjs"` over the direct Postgres URL.
- Every migration must be backward compatible (expand → migrate → contract), because the new container already serves traffic when it runs.
- If the migration step fails, the workflow fails; roll back or fix forward.

Reference: `docs/tasks/TASK-022.feedback.md` "Why migrations run AFTER deploy", `docs/02-ARCHITECTURE.md` §5.3.

## 5. Grant platform admin

The user must log in once first. Then, on the server, find the web container (`docker ps --filter label=service=cherrio-web-dev`) and run `docker exec <container> node packages/db/dist/grant-admin.mjs <address>`; reload `/en/admin`. Same for uat with `service=cherrio-web-uat`. The script refuses users who have not logged in. Reference: `docs/CHEATSHEET.md` §1 "Admin panel".

## 6. Indexer operations

| Task | Reference |
|---|---|
| First-time setup per env (role password in `infra.env`, `ensure-databases.sh --dry-run` then real run, two GitHub secrets, `.kamal/secrets-common`) | cheat sheet §10.1 |
| Daily: logs, `/status`, `/ready`, `reconcile.mjs`, `prune.mjs --dry-run` / `prune.mjs`, memory, `docker port` (must be empty) | cheat sheet §10.2 |
| SQL checks: schemas, web role reads `chain.*` only, indexer role denied on `app`, connections per role (budget web 18, indexer 10) | cheat sheet §10.3 |
| Restart, rollback, re-index from scratch (drop `chain_<sha7>`; keep `ponder_sync` unless the cache is suspect) | cheat sheet §10.4 |

Readers must use only the `chain.*` views, never `chain_<sha7>` (ADR-026). During a re-index the views are absent until `/ready`.

## 7. Backups and restore

- Until mainnet the official backup is the **Hetzner daily server snapshot** (7 days), per ADR-023.
- Off-site: systemd timer at 02:30 UTC dumps `cherrio_prod` daily and `cherrio_uat` on Sundays, encrypts with age and uploads to the Storage Box. Check: `systemctl list-timers cherrio-backup*` and `journalctl -u cherrio-backup --since today` (cheat sheet §5).
- Restore drill (monthly, first Sunday): decrypt on the Mac with the age private key and pipe into `restore.sh --stdin cherrio_restore_test`; compare row counts with `restore.sh --counts`; drop the test DB; delete the local copy. The private key never goes to the server. Reference: `infra/backups/RESTORE-DRILL.md`.
- Server lost: follow "Emergency Recovery" in `infra/backups/RESTORE-DRILL.md` (provision → harden → restore `infra.env` → sync → `ensure-databases.sh` → compose up → restore with `--target cherrio_prod --i-know-this-is-prod` → DNS → redeploy).
- Open: repeat the drill with real tables (cheat sheet §9).

## 8. Monitoring access (SSH tunnel only)

- Grafana: `ssh -L 3000:127.0.0.1:3000 deploy@<server>` then http://localhost:3000, user `admin`, password from the password manager / `infra.env` (`GRAFANA_ADMIN_PASSWORD`). Prometheus and Loki are internal and used through Grafana data sources.
- Postgres (TablePlus or psql): SSH tunnel to `127.0.0.1:5432`, use the per-env `cherrio_*` role, not `postgres`; mark prod red + Safe mode.
- Prometheus alert rules exist (disk, memory, restarts, Postgres down, container near limit) but alert delivery is not configured yet — check Grafana manually.

Reference: `docs/CHEATSHEET.md` §3 "TablePlus", §4; `infra/README.md` "Grafana access", "Postgres access via tunnel".

---

## 9. Incident checklist

Start every incident with: `curl -s https://dev.cherr.io/api/health`, `docker ps`, `docker stats --no-stream`, `free -h && df -h /`. Do not restart shared infra (Postgres) or change firewall/sshd without a plan; all fixes go into `infra/` first.

### 9.1 Login is failing

1. Watch the app log while logging in: `docker logs -f --since 1m <web container>` → look for `Session creation error` (cheat sheet §1).
2. `/api/health` returns `auth_config_error` → `PRIVY_APP_ID`, `PRIVY_APP_SECRET` or `SESSION_SECRET` missing/invalid in the GitHub Environment or Kamal destination; redeploy after fixing.
3. `db_unreachable` → the session route cannot write users; go to 9.3.
4. Origin mismatch (403) → the request must come from the env's own origin (`https://dev.cherr.io`); also check the domain is an allowed origin in the Privy app. Prod needs its own Privy app (open item).
5. 409 on login → the wallet is already linked to another account (by design).

### 9.2 Deploy fails with `Connection reset by peer` (SSH)

Cause seen in practice: brute-force bots fill sshd's unauthenticated slots, so GitHub Actions connections are dropped. Fix (cheat sheet §2, `infra/provision/protect-ssh.sh`):

1. On the Mac: `bash infra/sync.sh --live`.
2. On the server: `sudo bash /opt/cherrio/infra/provision/protect-ssh.sh` (`LoginGraceTime 20`, `MaxStartups 30:30:120`, `PerSourceMaxStartups 3`, fail2ban sshd 24 h + recidive 1 week). Keep the current session open; verify a new login.
3. Check: `sudo fail2ban-client status sshd`; `sudo journalctl -u ssh --since "1 hour ago" | grep -c MaxStartups` should stay low.
4. Re-run the "Deploy" workflow. If the host key changed (server rebuilt), update the `SSH_KNOWN_HOSTS` secret.

### 9.3 PgBouncer authentication errors / `db_unreachable`

Symptom seen in practice: `server login failed: wrong password type`. Cause: `userlist.txt` contained only SCRAM verifiers, so PgBouncer could not open server connections. Fix (cheat sheet §3):

1. `sudo bash /opt/cherrio/infra/shared/ensure-databases.sh --dry-run` (prints, changes nothing), then without `--dry-run`. It regenerates `pgbouncer.ini` + `userlist.txt` (plain-text passwords from `infra.env`, mode 600, uid 70) and **restarts PgBouncer — all environments reconnect for a few seconds**.
2. `docker logs --since 2m cherrio-infra-pgbouncer-1 2>&1 | tail -20`.
3. `curl -s https://dev.cherr.io/api/health` must show `"db":"ok"`.
4. Re-run after any password change in `infra.env`.
5. `too many connections for role …` → check per-role counts (cheat sheet §10.3); for the indexer during a deploy, stop the old container and re-run the deploy (§10.4).

### 9.4 Docker issues

| Symptom | What happened / fix | Reference |
|---|---|---|
| Apps cannot resolve `cherrio-infra-postgres-1` / `-pgbouncer-1` | Infra services were not on the `kamal` network. `docker network create kamal`, then `docker compose … down` / `up -d` in `/opt/cherrio/infra/shared`; verify with `docker network inspect kamal` | `docs/tasks/TASK-022.feedback.md` |
| PgBouncer container exits at start | Official image entrypoint needs `DATABASES_HOST`; compose overrides the entrypoint to run with the generated `pgbouncer.ini`. Ensure `ensure-databases.sh` ran first so the config exists | `docs/tasks/TASK-024.feedback.md`, `infra/shared/compose.yml` |
| `docker stats` shows a container with host-size memory | It lacks `mem_limit` (happened with node-exporter); add the limit in `compose.yml` and recreate | `docs/tasks/TASK-024.feedback.md` |
| `kamal app exec` fails: env file not found | Kamal uploads env files only during `kamal deploy`; run exec after a deploy | `docs/tasks/TASK-022.feedback.md` |
| Container restarting / OOM | `dmesg \| grep -i 'oom\|killed'`, `docker stats`, check limits; restart Postgres via compose only if it was killed | `infra/README.md` "OOM" |
| Disk full | `df -h`, `docker system df`, `docker image prune -a --filter "until=720h"`, check `/opt/cherrio/backups` | `infra/README.md` "Disk full" |
| Postgres won't start | `docker compose … logs postgres --tail=50`; disk full, data corruption (restore from backup) or memory settings | `infra/README.md` "Postgres won't start" |

### 9.5 Locked out of SSH

Hetzner Cloud Console → server → Console; fix the drop-in files in `/etc/ssh/sshd_config.d/`; `systemctl reload ssh`. Reference: `infra/README.md` "Recovery if locked out of SSH".

Sources: `docs/CHEATSHEET.md` §1–§6, §9, §10; `infra/README.md`; `infra/backups/RESTORE-DRILL.md`; `infra/provision/protect-ssh.sh`; `infra/shared/ensure-databases.sh`; `infra/shared/compose.yml`; `.github/workflows/deploy.yml`; `docs/tasks/TASK-022.feedback.md`; `docs/tasks/TASK-024.feedback.md`; `docs/tasks/TASK-025.feedback.md`; `docs/tasks/TASK-026.feedback.md`; ADR-023, ADR-026.

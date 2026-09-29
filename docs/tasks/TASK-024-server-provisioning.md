# TASK-024 — Server provisioning, hardening, shared infra

Runs after TASK-001, in parallel with the contract tasks. TASK-022 (app deploys) depends on it.
Read first: `docs/00-MANIFEST.md` (esp. "Server access"), `docs/02-ARCHITECTURE.md` §5, ADR-020, ADR-021.

## Server
Hetzner CX33 · 4 vCPU · 8 GB RAM · 80 GB SSD · Ubuntu 26.04 · `49.13.63.71` · SSH key auth (currently `root`).

## Goal
A hardened host running the shared infra layer (Postgres with 3 databases, PgBouncer, monitoring, backups), ready for Kamal to deploy dev/uat/prod apps. Everything reproducible from the repo.

## Scope

### Part A — `infra/provision/` (host bootstrap, run as root once)
`provision.sh` (idempotent, `--dry-run` supported, logs every step):
1. Set hostname `cherrio-1`, timezone **UTC**, locale `en_US.UTF-8`.
2. `apt update && apt full-upgrade`; install `unattended-upgrades` (security only, auto-reboot **off**), `fail2ban`, `ufw`, `curl`, `git`, `jq`, `age`, `rclone`, `htop`.
3. **Swap** 4 GB file, `vm.swappiness=10`, `vm.overcommit_memory=1` (Redis).
4. **Docker Engine** from Docker's official apt repo. Before installing, check that the repo publishes packages for Ubuntu 26.04's codename; if not, stop and report (do not fall back silently). `/etc/docker/daemon.json`: `log-driver json-file`, `max-size 10m`, `max-file 3`, `live-restore true`.
5. User **`deploy`**: copy root's `authorized_keys`, member of `docker` group, passwordless sudo (key-only login makes this acceptable for Phase 1 — note in feedback).
6. **UFW**: default deny incoming; allow 22, 80, 443. **fail2ban** sshd jail (maxretry 5, bantime 1h).
7. Directories: `/opt/cherrio/{infra,backups,secrets}` owned by `deploy`, `secrets` mode 700.
8. Print next steps; **do not** touch sshd config in this script.

`harden-ssh.sh` (separate, run only after David confirms `ssh deploy@49.13.63.71` works and `sudo -v` succeeds):
- `PermitRootLogin no`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `MaxAuthTries 3`; validate with `sshd -t` before reload; reload (not restart).

`docs` in `infra/README.md`: Hetzner Cloud Firewall manual steps (David does in console: inbound 22/80/443 only), recovery via Hetzner console if locked out.

### Part B — `infra/shared/` (docker compose, runs as `deploy` in `/opt/cherrio/infra`)
`compose.yml` with project name `cherrio-infra`, attached to an external Docker network **`kamal`** (create if missing) so Kamal apps can reach services by name. Every service has `mem_limit`, `restart: unless-stopped`, healthcheck, **no `ports:` published** (Grafana excepted: `127.0.0.1:3000:3000` only, for SSH tunnel).

- **postgres**: `pgvector/pgvector:pg16`, named volume, tuned for 8 GB host (`shared_buffers=1GB`, `effective_cache_size=3GB`, `work_mem=8MB`, `maintenance_work_mem=256MB`, `max_connections=100`), `mem_limit 1.5g`.
  - Init script `initdb/01-databases.sh`: roles `cherrio_dev`, `cherrio_uat`, `cherrio_prod` with passwords from env; databases of same name owned by each role; `CREATE EXTENSION vector` in each; `ALTER ROLE cherrio_dev/uat CONNECTION LIMIT 20` and `SET statement_timeout = '30s'`; revoke `CONNECT` on each DB from `PUBLIC`.
  - An idempotent `ensure-databases.sh` for running against an existing cluster (init scripts only run on first start).
- **pgbouncer**: transaction pooling, one entry per database, `mem_limit 64m`. Apps connect via `pgbouncer:6432`. Ponder connects **directly** to `postgres:5432` (session features) — document this.
- **Monitoring**: prometheus (15d retention, `mem_limit 384m`), node-exporter, cadvisor (`mem_limit 128m`), grafana (`mem_limit 192m`, admin password from env, provisioned Prometheus + Loki datasources and a "Host & containers" dashboard), loki (7d retention, `mem_limit 256m`), promtail (Docker container logs, `mem_limit 96m`). Basic alert rules file (disk > 80%, memory > 85%, container restarts, Postgres down) — alert delivery configured later.
- `.env.example` listing every variable; real `.env` lives only in `/opt/cherrio/secrets/infra.env` (600), never in the repo.

### Part C — `infra/backups/`
- `backup.sh`: `pg_dump -Fc` of `cherrio_prod` (daily 02:30 UTC) and `cherrio_uat` (Sundays) → `age` encrypt with public key from env → upload with `rclone` to remote `cherrio-backups:` (Hetzner Storage Box or Object Storage; David configures the rclone remote) → keep 14 daily + 8 weekly remote, 3 local. Exit non-zero and log on any failure.
- systemd **service + timer** units (not cron), installed by `install-backups.sh`.
- `restore.sh <dump> <target_db>`: refuses target `cherrio_prod` unless `--i-know-this-is-prod`; default restore target `cherrio_restore_test`.
- `RESTORE-DRILL.md`: monthly drill steps + checklist.

### Part D — Kamal preparation (no app deploys yet)
- Root `config/deploy.yml` skeleton + `deploy.dev.yml`, `deploy.uat.yml`, `deploy.prod.yml` with: host `49.13.63.71`, ssh user `deploy`, registry GHCR, proxy hosts per env (Architecture §5.1), Redis accessory per env with `maxmemory` + `maxmemory-policy allkeys-lru`, memory limits per service from the budget table, `retain_containers: 3`. Services may reference placeholder images — deploy wiring is TASK-022.
- `infra/README.md`: architecture sketch, memory budget, how to open Grafana (`ssh -L 3000:127.0.0.1:3000 deploy@49.13.63.71`), how to connect to Postgres via tunnel, runbook for "disk full", "OOM", "Postgres won't start".

## Execution rules (in addition to Manifest)
1. Write and lint all scripts locally first (`shellcheck`, `docker compose config`). Include output in feedback.
2. Show David the exact command before each server-changing step and wait for his OK. Suggested order: `provision.sh --dry-run` → `provision.sh` → David verifies deploy login → `harden-ssh.sh` → compose up → install backups → run one manual backup + restore to `cherrio_restore_test`.
3. After each step, run verification commands and paste results into feedback.

## Must not touch
`docs/**` (except feedback), `apps/**`, `packages/**`.

## Acceptance criteria
- `ssh root@49.13.63.71` is refused; `ssh deploy@49.13.63.71` works.
- `sudo ufw status` shows only 22/80/443; `ss -tlnp` shows no Postgres/Redis/Grafana on public interfaces.
- `docker compose ps` all healthy; `free -m` shows swap active; total container memory limits ≤ budget.
- From a throwaway container on network `kamal`: can connect to each DB with its own role; `cherrio_dev` role **cannot** connect to `cherrio_prod`.
- Grafana reachable through SSH tunnel, shows host + container metrics and logs.
- One successful encrypted backup uploaded and restored into `cherrio_restore_test` (row counts match).
- `docker info` shows log rotation settings.

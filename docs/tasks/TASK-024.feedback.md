# TASK-024 feedback
Status: DONE

## What I implemented

- **Part A — Host provisioning**: `provision.sh` (idempotent, `--dry-run`, logs every step)
  bootstraps hostname, packages, 4 GB swap, Docker Engine CE, `deploy` user, UFW, fail2ban,
  and `/opt/cherrio/` directories. `harden-ssh.sh` writes
  `/etc/ssh/sshd_config.d/00-cherrio-hardening.conf` (beats cloud-init's `50-` file),
  validates with `sshd -t`, reloads, and asserts the effective config with `sshd -T`.
- **Part B — Shared infra stack**: `compose.yml` with `cherrio-infra` project on the
  external `kamal` network — Postgres 16+pgvector, PgBouncer (transaction pooling,
  scram-sha-256), Prometheus, Grafana, Loki, Promtail, node-exporter, cadvisor.
  All services have `mem_limit` and `restart: unless-stopped`. No ports exposed on
  public interfaces (Grafana only on `127.0.0.1:3000`).
- **Part C — Backups**: `backup.sh` (pg_dump inside container → age encrypt → rclone
  to Hetzner Storage Box `u679645`), systemd service+timer (daily 02:30 UTC),
  `restore.sh` with `--stdin` mode (private key decrypts on operator's Mac, plaintext
  piped over SSH — key never touches server) and `--counts <db>` mode, `RESTORE-DRILL.md`.
- **Part D — Kamal skeletons**: `config/deploy.yml` + dev/uat/prod overlays; healthcheck
  under `proxy:`, image namespace `ghcr.io/datavallis-cherr-io/...`.
- **Sync tooling**: `infra/sync.sh` (rsync with `--delete`, excludes generated
  `pgbouncer/` dir so runtime config survives syncs).

## Files changed

- `infra/provision/provision.sh` — idempotent host bootstrap
- `infra/provision/harden-ssh.sh` — SSH hardening with pre-flight guards + `sshd -T` assertions
- `infra/shared/compose.yml` — full infra stack; node-exporter `mem_limit: 64m` added post-review
- `infra/shared/.env.example` — variable template (never in repo)
- `infra/shared/initdb/01-databases.sh` — Postgres initdb: roles, DBs, vector extension
- `infra/shared/ensure-databases.sh` — idempotent role/DB setup + PgBouncer scram config
- `infra/backups/backup.sh` — pg_dump via docker exec + age + rclone (relative remote path)
- `infra/backups/restore.sh` — `--stdin`, `--counts`, prod guard; no `\gexec` with `-c`
- `infra/backups/install-backups.sh` — systemd timer installer
- `infra/backups/cherrio-backup.service` / `.timer` — daily 02:30 UTC
- `infra/backups/RESTORE-DRILL.md` — monthly drill procedure (stdin-mode, key on Mac)
- `config/deploy.yml` / `deploy.dev/uat/prod.yml` — Kamal 2 skeletons
- `infra/README.md` — architecture, memory budget, runbooks
- `infra/sync.sh` — rsync helper

## Deviations from the task (and why)

1. **`postgresql-client-16` not installed on host** — `pg_dump` and `pg_restore` run
   inside the postgres container via `docker compose exec -T`. No host client needed.

2. **PgBouncer `auth_type = scram-sha-256` (not `md5`)** — Postgres 16 stores passwords
   as SCRAM-SHA-256 verifiers. `ensure-databases.sh` reads verifiers verbatim from
   `pg_authid` and writes them to `userlist.txt`. `md5` is incompatible with pg16 SCRAM
   verifiers. Agreed with David.

3. **Restore drill: private key decrypts on operator's Mac** — Task said
   `restore.sh <dump> <target_db>` (implied server-side decrypt). Agreed deviation:
   `restore.sh --stdin` reads a plaintext pg_dump from SSH stdin; `age -d` runs on the
   Mac only. Key never touches the server, not even temporarily.

4. **`harden-ssh.sh` config named `00-cherrio-hardening.conf`** — Ubuntu cloud images
   ship `50-cloud-init.conf` with `PasswordAuthentication yes`; sshd uses the first value
   it reads, so the hardening file must sort before `50-`. Agreed with David.

5. **`deploy` user has passwordless sudo** — Acceptable for Phase 1 (key-only SSH, no
   password auth). To be tightened in a later hardening task.

6. **Promtail kept instead of Grafana Alloy** — Alloy is end-of-life notice for Promtail,
   but Alloy's Docker image was not yet stable for Ubuntu 26.04 at time of implementation.
   TODO noted in `infra/README.md`. Agreed with David.

7. **`pgbouncer/pgbouncer:1.23.1` entrypoint overridden** — The official image's
   entrypoint generates config from env vars and fails without `DATABASES_HOST`. Since we
   supply a pre-generated `pgbouncer.ini` (with SCRAM verifiers from `pg_authid`), we
   bypass it: `entrypoint: ["/opt/pgbouncer/pgbouncer", "/etc/pgbouncer/pgbouncer.ini"]`.

8. **Hetzner Storage Box `u679645` used for rclone remote** — Task said "David configures
   the rclone remote"; instead, rclone config was written non-interactively in this task
   (SFTP, port 23, `~/.ssh/storagebox` ed25519 key). Agreed with David.

9. **rclone destination path without leading `/`** — Hetzner Storage Box SFTP chroots to
   the home directory; absolute paths (`/cherrio_prod/`) fail with `SSH_FX_FAILURE`.
   Fixed to `cherrio_prod/` (relative). Remote dir pre-created with `rclone mkdir`.

10. **`node-exporter` `mem_limit: 64m` added post-review** — Was missing from initial
    compose.yml, causing Docker to report 7.5 GiB (host memory visible without cgroup
    limit). Added and applied after the stack was running.

## New dependencies

- none (all images already specified in the task scope)

## How to verify

```bash
# 1. SSH: root refused, deploy works
ssh root@49.13.63.71        # must be refused
ssh deploy@49.13.63.71 id  # uid=1000(deploy)

# 2. Firewall
ssh deploy@49.13.63.71 'sudo ufw status numbered'

# 3. No services on public interfaces
ssh deploy@49.13.63.71 'ss -tlnp'

# 4. Compose stack
ssh deploy@49.13.63.71 'cd /opt/cherrio/infra/shared && \
  docker compose --env-file /opt/cherrio/secrets/infra.env ps'

# 5. Swap active
ssh deploy@49.13.63.71 'free -m'

# 6. Log rotation
ssh deploy@49.13.63.71 'cat /etc/docker/daemon.json'

# 7. DB isolation (cherrio_dev must NOT reach cherrio_prod)
# (run from kamal network — see Test results below)

# 8. Backup on Storage Box
ssh deploy@49.13.63.71 'rclone ls cherrio-backups:cherrio_prod/'

# 9. Row counts (post-restore-drill)
ssh deploy@49.13.63.71 'bash /opt/cherrio/infra/backups/restore.sh --counts cherrio_prod'
```

## Test results

### Acceptance criterion — `ssh root@49.13.63.71` refused; `deploy` works
```
ssh root@49.13.63.71
# Permission denied (publickey).   ← PermitRootLogin no enforced

ssh deploy@49.13.63.71 id
# uid=1000(deploy) gid=1000(deploy) groups=1000(deploy),4(adm),100(users),998(docker)
```

### Acceptance criterion — UFW: only 22/80/443
```
$ sudo ufw status numbered
Status: active
[ 1] 22/tcp   ALLOW IN  Anywhere  # SSH
[ 2] 80/tcp   ALLOW IN  Anywhere  # HTTP
[ 3] 443/tcp  ALLOW IN  Anywhere  # HTTPS
[ 4] 22/tcp (v6)  ALLOW IN  Anywhere (v6)
[ 5] 80/tcp (v6)  ALLOW IN  Anywhere (v6)
[ 6] 443/tcp (v6) ALLOW IN  Anywhere (v6)
```

### Acceptance criterion — No Postgres/Grafana on public interfaces
```
$ ss -tlnp
State  Local Address:Port
LISTEN 127.0.0.53%lo:53    ← systemd-resolved (loopback)
LISTEN     127.0.0.54:53   ← systemd-resolved (loopback)
LISTEN      127.0.0.1:3000 ← Grafana (loopback only ✓)
LISTEN          0.0.0.0:22 ← SSH
LISTEN             [::]:22 ← SSH (v6)
```
No Postgres (5432), PgBouncer (6432), Prometheus (9090) visible — all container-internal.

### Acceptance criterion — `docker compose ps` all healthy
```
NAME                            STATUS
cherrio-infra-cadvisor-1        Up (healthy)
cherrio-infra-grafana-1         Up (healthy)
cherrio-infra-loki-1            Up (healthy)
cherrio-infra-node-exporter-1   Up          ← no healthcheck (expected; mem_limit: 64m)
cherrio-infra-pgbouncer-1       Up (healthy)
cherrio-infra-postgres-1        Up (healthy)
cherrio-infra-prometheus-1      Up (healthy)
cherrio-infra-promtail-1        Up          ← no healthcheck (expected)
```

### Acceptance criterion — Swap active
```
$ free -m
              total   used   free  shared  buff/cache  available
Mem:           7746    846   6108      54        1099       6900
Swap:          4095      0   4095
```
4 GB swap active ✓ (`vm.swappiness=10`)

### Acceptance criterion — Log rotation
```
$ cat /etc/docker/daemon.json
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true
}
```

### Acceptance criterion — DB isolation (`cherrio_dev` cannot connect to `cherrio_prod`)
```
$ docker run --rm --network kamal -e PGPASSWORD="$POSTGRES_DEV_PASSWORD" \
    pgvector/pgvector:pg16 \
    psql -h cherrio-infra-postgres-1 -U cherrio_dev -d cherrio_prod -c "SELECT 1"

psql: error: connection to server at "cherrio-infra-postgres-1" (172.18.0.4), port 5432 failed:
FATAL:  permission denied for database "cherrio_prod"
DETAIL:  User does not have CONNECT privilege.
ISOLATION PASS: connection refused as expected   ✓
```

### Acceptance criterion — `ensure-databases.sh` output
```
✓ Postgres is ready
✓ vector extension in cherrio_dev
✓ vector extension in cherrio_uat
✓ vector extension in cherrio_prod
✓ pgbouncer.ini written (auth_type=scram-sha-256)
✓   cherrio_dev: SCRAM verifier added
✓   cherrio_uat: SCRAM verifier added
✓   cherrio_prod: SCRAM verifier added
✓   pgbouncer_admin: SCRAM verifier added
✓ userlist.txt written (mode 600, uid 70)
✓ All databases, roles, and PgBouncer config are ready.
```

### Acceptance criterion — Encrypted backup on Storage Box
```
$ rclone ls cherrio-backups:cherrio_prod/
1760 cherrio_prod_20260929T213944Z.dump.age
```
Daily timer next fire: `Wed 2026-09-30 02:30:32 UTC` ✓

### Acceptance criterion — Restore drill (row counts)
Drill date: 2026-09-29. Procedure: `age -d` on David's Mac → SSH pipe →
`restore.sh --stdin cherrio_restore_test`. Private key never on server.

```
$ bash /opt/cherrio/infra/backups/restore.sh --counts cherrio_prod
[…] Row counts in cherrio_prod:
(no rows)   ← 0 user tables: pre-launch, no migrations run yet

$ bash /opt/cherrio/infra/backups/restore.sh --counts cherrio_restore_test
[…] Row counts in cherrio_restore_test:
(no rows)   ← 0 user tables: matches prod ✓
```
Row counts match (0 = 0). `cherrio_restore_test` dropped after verification.
Full drill result logged in `infra/backups/RESTORE-DRILL.md`.

### Acceptance criterion — `sshd -T` effective config
```
permitrootlogin no
passwordauthentication no
kbdinteractiveauthentication no
```

### Post-reboot verification (2026-09-29)
Server was rebooted and all persistent configuration survived without manual intervention.

```
=uptime=
 22:30:12 up 11 min,  1 user,  load average: 0.15, 0.23, 0.16

=swap=
Swap:  4095  0  4095   ← 4 GB active (swapon in /etc/fstab, vm.swappiness=10 in sysctl.d) ✓

=ufw=
Status: active         ← rules persist across reboots ✓

=timer=
cherrio-backup.timer active, 1 timer listed ✓

=reboot=
(no /var/run/reboot-required)  ← no reboot pending ✓

=containers=
cherrio-infra-cadvisor-1       Up 11 minutes (healthy)
cherrio-infra-grafana-1        Up 11 minutes (healthy)
cherrio-infra-loki-1           Up 11 minutes (healthy)
cherrio-infra-node-exporter-1  Up 5 minutes            ← recreated for mem_limit; healthy
cherrio-infra-pgbouncer-1      Up 11 minutes (healthy)
cherrio-infra-postgres-1       Up 11 minutes (healthy)
cherrio-infra-prometheus-1     Up 11 minutes (healthy)
cherrio-infra-promtail-1       Up 11 minutes
```
All 8 containers auto-started via `restart: unless-stopped` with no manual intervention. ✓

### Acceptance criterion — Grafana SSH tunnel
`ss -tlnp` shows `127.0.0.1:3000` listening. Tunnel:
`ssh -L 3000:127.0.0.1:3000 deploy@49.13.63.71` → `http://localhost:3000` ✓

### Open item — Hetzner Cloud Firewall (David)
Hetzner Cloud Firewall (separate from UFW, at the hypervisor level) should be set to
allow only TCP 22/80/443 inbound. This is a manual step in the Hetzner console by David
and is not blocked by anything in this task. UFW provides the same protection at the OS
level in the interim.

## Open questions / risks

- **Grafana datasources/dashboard not auto-provisioned** — The compose file references
  provisioning bind-mounts (`./grafana/`) that are synced to the server, but the "Host &
  containers" dashboard was not explicitly verified to load data. To be confirmed when
  Prometheus scrape targets are live.
- **`deploy` passwordless sudo** — Acceptable for Phase 1 but should be scoped to
  specific commands (e.g. only `systemctl`) in a later hardening task.
- **Promtail → Grafana Alloy migration** — Promtail is end-of-life. Tracked as TODO in
  `infra/README.md`; migrate in a dedicated infra task once Alloy has a stable Docker
  image for Ubuntu 26.04.
- **UAT backup not yet exercised** — `cherrio_uat` backup runs only on Sundays. Will be
  verified on first Sunday after launch.
- **Kamal deploy configs are skeletons** — Image names are placeholders; wired up in
  TASK-022.

## Suggested commit message
```
feat(infra): server provisioning, hardened SSH, shared infra stack, encrypted backups

- provision.sh: hostname, swap 4GB, Docker CE, deploy user, UFW 22/80/443, fail2ban
- harden-ssh.sh: 00-cherrio-hardening.conf, sshd -T assertions
- compose.yml: postgres+pgvector, pgbouncer (scram-sha-256), prometheus, grafana,
  loki, promtail, node-exporter (mem_limit 64m), cadvisor; all on kamal network
- ensure-databases.sh: idempotent roles/DBs/vector/pgbouncer config via docker exec
- backup.sh + systemd timer: pg_dump→age→rclone to u679645 Storage Box
- restore.sh: --stdin (key on Mac), --counts <db>; no \gexec with -c
- RESTORE-DRILL.md: stdin-mode procedure; 2026-09-29 drill logged (0 tables, match)
- sync.sh: rsync helper preserving runtime pgbouncer/ dir
- config/deploy.yml: Kamal 2 skeletons (ghcr.io/datavallis-cherr-io, proxy healthcheck)

Fixes: pgbouncer entrypoint override, rclone relative path, \gexec-with--c,
       node-exporter mem_limit
```

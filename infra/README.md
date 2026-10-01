# CHERR.IO Infrastructure

Server: Hetzner CX33 · 4 vCPU · 8 GB RAM · 80 GB SSD · Ubuntu 26.04 · `49.13.63.71`

## Architecture

```
                    ┌──────── kamal-proxy (80/443) ─────────┐
                    │  TLS-terminated, routes by Host header │
                    └──┬──────────────┬───────────────┬──────┘
                       │              │               │
              cherrio-web-*   cherrio-indexer-*  cherrio-worker-*
               (3 envs)          (3 envs)           (3 envs)
                       │              │
              ┌────────▼──────────────▼────────┐
              │    cherrio-infra (compose)       │
              │  ┌──────────┐  ┌────────────┐  │
              │  │ postgres │  │ pgbouncer  │  │
              │  │  pg16    │  │ :6432      │  │
              │  └──────────┘  └────────────┘  │
              │  ┌──────────────────────────┐  │
              │  │ monitoring stack          │  │
              │  │ prometheus node-exporter  │  │
              │  │ cadvisor grafana loki     │  │
              │  │ promtail (→ Alloy TODO)   │  │
              │  └──────────────────────────┘  │
              └─────────────────────────────────┘
```

All services share the external Docker network **`kamal`** (created by Kamal on first deploy).

> **TODO (post-Phase-1):** Migrate `promtail` → Grafana Alloy once a stable
> Docker image is published for Ubuntu 26.04 / amd64. Alloy is the upstream
> successor to both Promtail and Grafana Agent.

Ponder (`apps/indexer`) connects **directly** to `postgres:5432` — it uses LISTEN/NOTIFY and
cannot use PgBouncer transaction pooling. All other apps connect via `pgbouncer:6432`.

## Database roles and connection budget

Postgres `max_connections = 100`. Every role has a hard `CONNECTION LIMIT`, so one
environment cannot starve another. The numbers are set by `shared/ensure-databases.sh`.

| Per environment | Connections | Where it is set |
|---|---|---|
| Web role `cherrio_<env>` — limit | **18** | `ALTER ROLE … CONNECTION LIMIT 18` |
| — PgBouncer pool | 14 | `default_pool_size` |
| — PgBouncer reserve pool | 2 | `reserve_pool_size` |
| — direct (migrations, GDPR erase) | 2 | remainder of the role limit |
| Indexer role `cherrio_indexer_<env>` — limit | **10** | `shared/indexer-role.sql` |
| — Ponder | at most 5 pooled + 1 LISTEN (5 measured at start, 2 when idle) | `poolConfig.max: 5` in `apps/indexer/ponder.config.ts` |
| — old + new version during a deploy | 7 measured locally (worst case 12) | Kamal starts the new version before stopping the old one |
| — reconcile, prune (after the old version stopped) | 1 each | deploy job |

| Total | Connections |
|---|---|
| 3 environments × (18 + 10) | 84 |
| Superuser, backup (`pg_dump`), maintenance | 6 |
| **Sum** | **90 of 100** |

**Indexer role** (ADR-026, TASK-026): `cherrio_indexer_<env>` is created only when
`POSTGRES_INDEXER_<ENV>_PASSWORD` is set in `infra.env`. It may connect to its own
database and create schemas there (`chain_<sha7>`, `ponder_sync`); it owns schema `chain`.
It has **no** privilege on schema `app`, and it is not in PgBouncer's `userlist.txt`, so it
can only connect directly. The web role may `SELECT` from every view in `chain` — also
views a later deploy re-creates — through default privileges on that schema; it cannot
read `chain_<sha7>` or `ponder_sync`.

`ensure-databases.sh --dry-run` prints the SQL and the PgBouncer config without applying
anything. A real run **restarts PgBouncer**: all environments reconnect for a few seconds.

## Memory budget (8 GB + 4 GB swap)

| Component             | Budget  |
|-----------------------|---------|
| Postgres (shared)     | 1.5 GB  |
| web ×3 dev/uat 384 MB / prod 768 MB | 1.5 GB |
| indexer ×3 256–384 MB | 1.0 GB  |
| worker ×3 192–384 MB  | 0.8 GB  |
| mcp (prod)            | 0.15 GB |
| Redis ×3 64/64/256 MB | 0.4 GB  |
| kamal-proxy + pgbouncer | 0.1 GB |
| Monitoring stack      | 0.9 GB  |
| OS + Docker           | 0.6 GB  |
| **Total**             | **≈ 6.95 GB** |

## Initial provisioning order

```bash
# 1. Bootstrap host (run as root via Hetzner console or existing SSH)
bash infra/provision/provision.sh

# 2. Verify deploy user login — open a NEW terminal:
ssh deploy@49.13.63.71 'sudo -v && echo OK'

# 3. Harden SSH (see warning in script — keep current session open!)
sudo bash infra/provision/harden-ssh.sh

# 4. Keep SSH reachable under brute-force scanning (MaxStartups, fail2ban)
sudo bash infra/provision/protect-ssh.sh

# 5. Create Hetzner Cloud Firewall (David does this in the Hetzner console):
#    Inbound: TCP 22, 80, 443 — all other inbound DENY
#    See "Hetzner Cloud Firewall" section below.

# 5. Copy shared infra to server
rsync -av infra/shared/ deploy@49.13.63.71:/opt/cherrio/infra/

# 6. Create secrets file
ssh deploy@49.13.63.71
cp /opt/cherrio/infra/.env.example /opt/cherrio/secrets/infra.env
chmod 600 /opt/cherrio/secrets/infra.env
nano /opt/cherrio/secrets/infra.env   # fill in real passwords

# 7. Create Docker network (Kamal creates it too, but we need it for infra first)
docker network create kamal || true

# 8. Start Postgres first, run ensure-databases.sh, then start everything
cd /opt/cherrio/infra/shared
docker compose --env-file /opt/cherrio/secrets/infra.env up -d postgres
sleep 15
bash /opt/cherrio/infra/shared/ensure-databases.sh /opt/cherrio/secrets/infra.env
docker compose --env-file /opt/cherrio/secrets/infra.env up -d

# 9. Verify
docker compose --env-file /opt/cherrio/secrets/infra.env ps

# 10. Install backup timer
sudo bash /opt/cherrio/infra/backups/install-backups.sh

# 11. Configure rclone (David):
#     rclone config → name it "cherrio-backups" → Hetzner Storage Box or Object Storage

# 12. Run first manual backup + restore drill
sudo systemctl start cherrio-backup.service
journalctl -u cherrio-backup -f
bash /opt/cherrio/repo/infra/backups/restore.sh <dump.age>
```

## Grafana access (SSH tunnel)

Grafana is only bound to `127.0.0.1:3000` on the server. Access via tunnel:

```bash
ssh -L 3000:127.0.0.1:3000 deploy@49.13.63.71 -N
# Then open: http://localhost:3000
# Login: admin / <GRAFANA_ADMIN_PASSWORD from infra.env>
```

## Postgres access via tunnel

```bash
ssh -L 5433:127.0.0.1:5432 deploy@49.13.63.71 -N
# Then: psql -h 127.0.0.1 -p 5433 -U postgres postgres
```

## Hetzner Cloud Firewall (manual setup by David)

In Hetzner Cloud console → Firewalls → Create:
- Inbound TCP 22   (SSH)
- Inbound TCP 80   (HTTP)
- Inbound TCP 443  (HTTPS)
- All other inbound: **DENY**
- Assign to server `cherrio-1`

**Why**: Docker bypasses UFW for published ports. The Hetzner Cloud Firewall acts before the
host OS, blocking external access to any accidentally published ports.

## Recovery if locked out of SSH

1. Open Hetzner Cloud console → server → Console tab.
2. Log in as root (password set via console if needed, or re-enable password auth temporarily).
3. Fix `/etc/ssh/sshd_config.d/99-cherrio-hardening.conf`.
4. `systemctl reload ssh`.

## Runbooks

### Disk full

```bash
# Check what's using space
df -h && du -sh /opt/cherrio/backups/* | sort -rh | head -10
docker system df

# Clean old images (Kamal keeps last 3 per service automatically)
docker image prune -a --filter "until=720h"

# Clean old local backup files (backup.sh keeps 3, but check)
ls -lh /opt/cherrio/backups/
```

### OOM / container restarting

```bash
# Check which container was OOM-killed
dmesg | grep -i 'oom\|killed' | tail -20
docker stats --no-stream

# Check container memory limits
docker inspect <name> | jq '.[].HostConfig.Memory'

# If postgres is killed, restart infra:
cd /opt/cherrio/infra/shared
docker compose --env-file /opt/cherrio/secrets/infra.env restart postgres
```

### Postgres won't start

```bash
cd /opt/cherrio/infra/shared
docker compose --env-file /opt/cherrio/secrets/infra.env logs postgres --tail=50

# Common causes:
# 1. Disk full → see "Disk full" runbook
# 2. Data dir corruption → restore from backup (see RESTORE-DRILL.md)
# 3. Shared memory too large → check shared_buffers in compose.yml vs available RAM
```

### Weekly image prune (run manually or add to cron)

```bash
# Kamal retains last 3 container versions; prune dangling build artifacts
docker image prune -f
```

# CHERR.IO — Monthly Restore Drill

Run this drill on the **first Sunday of each month**.
Document results in the Drill Log below.

## Design principle

The age **private key never touches the server**, not even temporarily.
Decryption happens on the operator's Mac; the plaintext dump is piped over SSH
directly into the postgres container via `restore.sh --stdin`.

## Prerequisites

| What | Where |
|------|-------|
| age private key | `~/cherrio-backup.key` on your Mac (`chmod 600`) |
| `age` CLI on Mac | `brew install age` if missing |
| SSH access | `ssh deploy@49.13.63.71` |

---

## Drill Steps

### 1. Find the latest backup on the server

```bash
ssh deploy@49.13.63.71 'ls -lht /opt/cherrio/backups/*.dump.age | head -5'
```

Note the filename — e.g. `cherrio_prod_20261005T023000Z.dump.age`.

**Expected**: file present, timestamp ≤ 2 days ago (daily cron), non-zero size.

☐ Passed / ☐ Failed — Notes: ___

---

### 2. Copy the encrypted dump to your Mac

```bash
scp deploy@49.13.63.71:/opt/cherrio/backups/cherrio_prod_YYYYMMDDTHHMMSSZ.dump.age ~/
```

**Expected**: file lands in `~/`, same size as on server.

☐ Passed / ☐ Failed — Notes: ___

---

### 3. Decrypt on Mac, pipe into restore on server

```bash
age -d -i ~/cherrio-backup.key ~/cherrio_prod_YYYYMMDDTHHMMSSZ.dump.age | \
  ssh deploy@49.13.63.71 \
    'bash /opt/cherrio/infra/backups/restore.sh --stdin cherrio_restore_test'
```

What this does:
1. `age -d` decrypts locally on your Mac — private key never leaves it
2. Plaintext pg_dump (-Fc) is piped over SSH stdin
3. `restore.sh --stdin` buffers it, creates `cherrio_restore_test` if missing,
   runs `pg_restore` inside the postgres container, and prints row counts

**Expected**: restore completes without error, row counts printed.

☐ Passed / ☐ Failed — Notes: ___

---

### 4. Compare row counts with cherrio_prod

```bash
ssh deploy@49.13.63.71 \
  'bash /opt/cherrio/infra/backups/restore.sh --counts cherrio_prod'

ssh deploy@49.13.63.71 \
  'bash /opt/cherrio/infra/backups/restore.sh --counts cherrio_restore_test'
```

**Expected**: each table shows the same row count in both outputs
(small tolerance acceptable for tables with active writes at backup time).

☐ Passed / ☐ Failed — Notes: ___

---

### 5. Drop the test database

```bash
ssh deploy@49.13.63.71 '
  cd /opt/cherrio/infra/shared
  docker compose --env-file /opt/cherrio/secrets/infra.env exec -T postgres \
    psql -U postgres -c "DROP DATABASE IF EXISTS cherrio_restore_test;"
'
```

☐ Done

### 6. Remove the local copy from your Mac

```bash
rm ~/cherrio_prod_YYYYMMDDTHHMMSSZ.dump.age
```

☐ Done

---

## Drill Log

| Date | Backup file | Restored DB | Row-count match | Operator | Notes |
|------|-------------|-------------|-----------------|----------|-------|
| 2026-09-29 | cherrio_prod_20260929T213944Z.dump.age | cherrio_restore_test | ✓ PASS — 0 user tables in both (pre-launch, no migrations run yet) | David | Full pipeline verified: age decrypt on Mac → SSH pipe → pg_restore in container → counts matched |

---

## Emergency Recovery (unplanned — server lost)

1. Provision a new Hetzner CX33 with Ubuntu 26.04:
   `bash infra/provision/provision.sh` as root on the new box.
2. `ssh deploy@<new-ip>` — confirm login works.
3. `bash infra/provision/harden-ssh.sh`
4. Restore `/opt/cherrio/secrets/infra.env` from 1Password (never in repo).
5. `bash infra/sync.sh --live` (update IP in sync.sh first).
6. `bash /opt/cherrio/infra/shared/ensure-databases.sh /opt/cherrio/secrets/infra.env`
7. `cd /opt/cherrio/infra/shared && docker compose --env-file /opt/cherrio/secrets/infra.env up -d`
8. Download latest encrypted backup from Storage Box and run the drill steps above
   (substitute `--target cherrio_prod --i-know-this-is-prod` in step 3).
9. Update DNS to the new IP.
10. Redeploy apps: `kamal deploy -d prod` (update server IP in deploy configs first).

# 08 — Operations

A short operator guide for CHERR.IO. It summarises the day-to-day procedures and points to the exact section of `docs/CHEATSHEET.md` (the authoritative, step-by-step operator sheet) or `infra/README.md` for each one: health checks, logs, deploy and rollback, migrations, granting admin, indexer operations, backups and restore, monitoring access through an SSH tunnel, and an incident checklist built from problems that actually occurred during setup (failed logins, deploy SSH resets, PgBouncer authentication errors, Docker issues). This guide contains no secrets and no server address: secrets live in the password manager, `/opt/cherrio/secrets/infra.env` (mode 600) or GitHub; the server address is in the cheat sheet. Below, `<server>` stands for it.

Last updated: 2026-10-07

Status: dev web app **Live on dev**; indexer **Live on dev** since 2026-10-01 (TASK-026); uat and prod **not deployed**.

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
| Deploy prod | Manual only: `workflow_dispatch` from `main` with environment `prod` (ADR-027); the `guard` job rejects any other branch/environment pair. Not done yet: prod is not live | cheat sheet §6 |
| Redeploy / force indexer | Actions → Deploy → "Run workflow" with matching branch and environment (`dev`/`dev`), or push a commit that changes an indexer input (`apps/indexer/**`, `packages/contracts/**`, `packages/shared/**`, `pnpm-lock.yaml`, `Dockerfile.indexer`, `config/indexer*.yml` or `.github/workflows/deploy.yml`) | cheat sheet §6, §10 |
| Roll back web | Re-run "Deploy" for the last good commit, or on the Mac with env vars exported: `kamal rollback -d dev sha-<good>` | cheat sheet §6 |
| Roll back indexer | `kamal rollback -c config/indexer.yml -d dev sha-<previous>` (one version back resumes; further = full re-index) | cheat sheet §10.4 |

A deploy is only marked healthy when `/api/health` passes (auth env + `select 1` through PgBouncer), the smoke tests (`/api/health` SHA, `/en`, `/en/dev/ui`) pass and, where a bucket is configured (dev), the private file storage check passes (§5.2). See `07-delivery-and-quality.md` §4.

## 3a. First uat and prod launch

The complete step-by-step list (code prerequisites, accounts, secrets with password-manager entry names, server commands, GitHub settings, contract deploy on Polygon, checks and rollback) is `docs/runbooks/prod-launch.md`. It is **Planned**: nothing in it has been run yet.

## 4. Migrations

- Run automatically by the deploy workflow **after** `kamal deploy`: `kamal app exec -d <env> --primary "node packages/db/dist/migrate.mjs"` over the direct Postgres URL.
- Every migration must be backward compatible (expand → migrate → contract), because the new container already serves traffic when it runs.
- If the migration step fails, the workflow fails; roll back or fix forward.

Reference: `docs/tasks/TASK-022.feedback.md` "Why migrations run AFTER deploy", `docs/02-ARCHITECTURE.md` §5.3.

## 5. Grant platform admin

The user must log in once first. Then, on the server, find the web container (`docker ps --filter label=service=cherrio-web-dev`) and run `docker exec <container> node packages/db/dist/grant-admin.mjs <address>`; reload `/en/admin`. Same for uat with `service=cherrio-web-uat`. The script refuses users who have not logged in. Reference: `docs/CHEATSHEET.md` §1 "Admin panel".

The new admin's first admin page asks for an authenticator app (ADR-056, TASK-049): QR code, first code, ten recovery codes shown once. After that a code every 12 hours.

### 5.0 Reset an admin's authenticator (**Live on dev** after TASK-049b deploys)

Only when the phone **and** all recovery codes are lost (a recovery code alone gets the admin in). Same container as grant-admin: `docker exec <container> node packages/db/dist/reset-admin-mfa.mjs <address>` → "Second factor removed for user …"; the next admin page asks to set up the app again; old 12-hour cookies stop working; audit `admin.mfa_reset`. Rotating `SESSION_SECRET` makes every stored TOTP secret unreadable (the key is derived from it) — run the reset for every admin after a rotation.

### 5.1 Review an organisation application (**Built**, TASK-008c-2)

1. Log in as a platform admin and open `/en/admin` → "Review organisation applications" (`/en/admin/kyb`). The oldest application is first.
2. Open the application. Check the applicant, the submitted data and, for a claim or a resubmission, the column "On CHERR.IO now": approving replaces those values with the submitted ones.
3. Download each document (every download is written to `audit_log`) and compare: register extract ↔ name, legal name and registration number; proof of representation ↔ the applicant; **payout address ↔ a document or a channel you trust**.
4. **Approve:** type the last 6 characters of the payout address in the dialog. The organisation becomes verified; for a claim the applicant becomes its owner.
5. **Reject:** write a note that tells the applicant what to fix (they see it and can submit again). A rejected claim leaves the imported organisation as it was.

You cannot review an application you submitted or one of an organisation you are a member of; ask another admin. A decision cannot be undone in the UI — a wrong approval must be corrected in the database by David, and a wrong rejection by asking the applicant to submit again.

Sources: `apps/web/src/app/[locale]/admin/kyb/**`, `apps/web/src/lib/organizations/review.ts`, ADR-012.

### 5.1a Review a campaign (**Live on dev**, TASK-010b)

1. Log in as a platform admin and open `/en/admin` → "Campaigns waiting for review" (`/en/admin/campaigns`). The oldest submission is first.
2. Open the campaign. Check title, story and cover for anything that must not be public (personal data of third parties, photos of people without consent, contact details), whether the cause and country fit the organisation, and whether the target and duration are plausible.
3. **Approve:** the dialog shows the payout address that will be fixed for this campaign (the organisation's verified address). On confirmation the server fetches today's ECB rate and stores the USDC target; the snapshot appears on the page. If the ECB cannot be reached, nothing is saved — try again later. If the target is below 100 USDC at the day's rate, reject and ask for a higher target.
4. **Reject:** write a note that tells the organisation what to change; they see it, can edit and submit again.

You cannot review a campaign of an organisation you belong to; ask another admin. An approval cannot be undone in the UI.

### 5.1b Publish a campaign on Polygon (**Live on dev**, TASK-010c)

Before: the operator wallet (amoy-dev: the testnet EOA, see `docs/CHEATSHEET.md` §7) is connected to your CHERR.IO account (Account → Wallets) and holds some Amoy POL for gas.

1. `/en/admin` → "Campaigns: review and publish" → list "Approved — waiting to be published" → open the campaign → "Publish on Polygon".
2. The page checks the wallet. A clear error appears if it is on the wrong network, lacks the operator role, or a transaction is still pending. Confirm the transaction in MetaMask.
3. The page waits for the transaction and then for the indexer (about a minute) and shows the contract address. If it stops waiting first, press "Check status" later; opening the page also links it.
4. If the transaction failed, press "Send again" — the same campaign ID cannot be created twice on-chain.
5. "Does not match" means a contract with this campaign's ID exists but with other data. It is not linked and is in the audit log. Stop and investigate.

Fees: Polygon (Amoy and mainnet) refuses a priority fee below 25 gwei, so the page sends at least 30 gwei (`maxFeePerGas` = 2 × base fee + tip). A wallet call that does not answer ends after a time limit with a message naming the wallets that were checked. Gas per `createCampaign`: about 332,000 gas, i.e. ≈ 0.01 POL at 30 gwei on Amoy (first publish on dev, 2026-10-02, block 49147789). Keep at least 0.1 POL on the operator wallet for ten campaigns.

Sources: `apps/web/src/app/[locale]/admin/campaigns/[id]/PublishPanel.tsx`, `apps/web/src/lib/campaigns/publish.ts`, ADR-035.

Sources: `apps/web/src/app/[locale]/admin/campaigns/**`, `apps/web/src/lib/campaigns/review.ts`, ADR-036.

### 5.1c Take down campaign media (**Built**, TASK-030)

Gallery images, video links and PDFs are public as soon as an organisation adds them; nobody reviews them first (ADR-039). When something must not be public (personal data of a third party, a photo of a person without consent, an invoice with names, unlawful or offensive content), or someone reports it:

1. Log in as a platform admin and open `/en/admin/campaigns` → the campaign (use the search; the "All" tab includes live campaigns).
2. In **Photos, videos and documents**, open the item to check it, then **Remove** → confirm in the dialog. The row is deleted and the file is removed from the public bucket (a video link is only a link; the video itself stays on YouTube/Vimeo).
3. The takedown is in `audit_log` as `campaign.media_takedown` (admin, campaign, media id, kind). Tell the organisation why, outside the app (there is no message yet).

A takedown cannot be undone; the organisation can add a corrected file. If the cover must go, there is no button yet — ask David (a database change).

Note: a CDN or browser may keep a removed file for a short time; the bucket itself returns 404 at once.

### 5.1d Display rates (**Built**, TASK-031)

The rates for the currency selector refresh themselves (ADR-040); nothing is scheduled.
- **Logs:** `[fx] ECB refresh failed: …` or `[fx] COINGECKO refresh failed: …` mean a source was not reachable. The old values are used until they are too old: crypto after 1 hour, fiat after 7 days. After that, amounts are shown only in their original currency. Nothing else breaks.
- **Check the stored rates:** `select currency, usd_per_unit, source, rate_at, fetched_at from app.fx_rates order by source, currency;` (read-only).
- **CoinGecko limits:** the keyless API allows roughly 10–30 calls per minute. We call it at most every 5 minutes per container. If it starts refusing (HTTP 429), create a free Demo key at CoinGecko and set it as the secret `COINGECKO_DEMO_API_KEY`. This needs a deploy configuration change and is David's decision.

### 5.2 Private files: storage check and sweep (**Built**, TASK-008a-2)

Both commands are in the web image (`apps/web/dist/files.mjs`) and print counts only — never object keys or configuration values. Run them like grant-admin: on the server, `docker exec <web container> node apps/web/dist/files.mjs <command>`.

| Command | What it does | When |
|---|---|---|
| `check` | Bucket reachable; writes, reads and deletes a probe object; decrypts the canary object with `PRIVATE_FILES_KEY` (creates it on the first run). Exit 1 on any failure | Automatically at the end of every web deploy; by hand after changing storage credentials |
| `sweep --dry-run` | Counts what `sweep` would delete; deletes nothing | Before a sweep |
| `sweep` | Deletes (1) files uploaded but never submitted, older than 24 h, (2) files of applications **rejected more than 90 days ago** (counted from the review, ADR-034; **Built**, TASK-008c-3) and (3) objects under `kyb/` without a live database row, older than 1 h. Files of approved and pending applications are never touched; the application row and the reviewer's note stay. Rows are marked deleted first. Exit 1 if an object could not be deleted (run it again) | **Weekly, by hand**, until the worker schedules it |

If `check` fails with "PRIVATE_FILES_KEY does not match…": the key in the GitHub Environment is not the one the stored files were encrypted with. Do **not** delete the canary; restore the key from the password manager (`CHERR.IO – private files key <env>`) and redeploy. Other failures name the missing variable or the S3 error (wrong credentials, bucket missing, endpoint unreachable).

Locally: `pnpm --filter web files:check` and `pnpm --filter web files:sweep [--dry-run]` with `APP_ENV=local`, `DATABASE_URL` and the local `PRIVATE_FILES_KEY` from `apps/web/.env.example`.

Sources: `apps/web/scripts/files.ts`, `apps/web/src/lib/files/check.ts`, `apps/web/src/lib/files/sweep.ts`, `.github/workflows/deploy.yml`, ADR-033, ADR-034.

## 6. Indexer operations

| Task | Reference |
|---|---|
| First-time setup per env (role password in `infra.env`, `ensure-databases.sh --dry-run` then real run, two GitHub secrets, `.kamal/secrets-common`) | cheat sheet §10.1 |
| Daily: logs, `/status`, `/ready`, `reconcile.mjs`, `prune.mjs --dry-run` / `prune.mjs`, memory, `docker port` (must be empty) | cheat sheet §10.2 |
| SQL checks: schemas, web role reads `chain.*` only, indexer role denied on `app`, connections per role (budget web 18, indexer 10) | cheat sheet §10.3 |
| Restart, rollback, re-index from scratch (drop `chain_<sha7>`; keep `ponder_sync` unless the cache is suspect) | cheat sheet §10.4 |

Readers must use only the `chain.*` views, never `chain_<sha7>` (ADR-026). During a re-index the views are absent until `/ready`.

## 6a. Worker operations (TASK-033e, ADR-048 — Built)

| Task | How |
|---|---|
| Is it running? | `docker exec $(docker ps -qf name=cherrio-worker-dev) wget -qO- http://127.0.0.1:8080/health` → `ok` (503 `stale` when no tick completed for 5 minutes; Docker then marks the container unhealthy) |
| What did it do? | `docker logs --tail 100 <container>` — a `[worker] tick {"points":…,"queued":…,"sent":…}` line only when something happened; the first line says whether email sending is on |
| Email queue | `app.notifications`: `PENDING` (waiting or backing off: 5, 10, 20, 40 min), `SENT`, `SKIPPED` (`last_error` = `unsubscribed` / `no_email` / `expired` — older than 3 days), `FAILED` (5 attempts). Re-send a failed row: `update app.notifications set status = 'PENDING', attempts = 0, send_after = now() where id = '…'` (within 3 days of its creation) |
| Turn email on | `docs/CHEATSHEET.md` §11.1 (GitHub secrets `SMTP_USER` / `SMTP_PASSWORD`, names in `.kamal/secrets-common`, `config/worker.dev.yml`) |
| Points | `app.points_ledger` rows `reason = VOTE` with `ref_key = vote:<campaign>:<round>`, one per bucket; `user_levels` balances are recomputed when points are added. Void an entry by setting `voided_at` / `voided_reason` (audited admin tool: Planned, TASK-015) |
| Stop / restart | Actions → Deploy → Run workflow (redeploys); on the server `docker restart <container>` is safe — a tick is idempotent and a half-sent row stays `PENDING` |

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


## 10. Operator licence obligations — **open item before prod**

The code is MIT (ADR-044). Privy, however, pulls proprietary wallet SDKs into the built web app. Their terms bind **the operator** of each running environment, not the source licence (details and versions: `THIRD_PARTY_NOTICES.md`):

| SDK | Free tier | Above it | Notice |
|---|---|---|---|
| Reown AppKit / WalletConnect | up to **500 MAU** or 2.5 M RPC calls a month; every embedded wallet created counts | commercial licence from Reown | "Portions © 2025 Reown, Inc. All Rights Reserved" plus a copy of the licence |
| MetaMask SDK | charitable organisations, or up to **10,000 MAU** | commercial licence from ConsenSys | "uses the MetaMask SDK, © ConsenSys Software Inc." |

- **Done (2026-10-03):** both notices are shown on `/en/licences` (footer link "Licences"), and the licence texts are linked.
- **Open, owner David, before production or above 500 MAU:** choose one of:
  1. obtain the Reown commercial licence;
  2. confirm in writing a charity/non-profit exemption with Reown (the MetaMask licence already names charities);
  3. configure Privy so that WalletConnect-based connectors are disabled. The SDKs stay in the bundle; whether that is enough has to be confirmed with Reown.
- dev/uat (testnet, a handful of users) stay far below the thresholds.

Sources: `THIRD_PARTY_NOTICES.md`; `apps/web/src/app/[locale]/licences/page.tsx`; `docs/tasks/LICENSE-MIT.feedback.md`; licence texts linked there.

Sources: `docs/CHEATSHEET.md` §1–§6, §9, §10; `infra/README.md`; `infra/backups/RESTORE-DRILL.md`; `infra/provision/protect-ssh.sh`; `infra/shared/ensure-databases.sh`; `infra/shared/compose.yml`; `.github/workflows/deploy.yml`; `docs/tasks/TASK-022.feedback.md`; `docs/tasks/TASK-024.feedback.md`; `docs/tasks/TASK-025.feedback.md`; `docs/tasks/TASK-026.feedback.md`; ADR-023, ADR-026.

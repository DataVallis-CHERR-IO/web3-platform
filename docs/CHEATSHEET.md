# CHERR.IO — Operator cheat sheet

Internal — contains server address and account ids; not for external distribution.

Last updated: 2026-10-03 · Owner: David (Data Vallis d.o.o.)

> **This file never contains passwords, keys or tokens.** It says *where* each secret lives.
> Secrets live in: (1) macOS **Passwords** app, (2) the server file `/opt/cherrio/secrets/infra.env` (mode 600), (3) GitHub → Settings → Secrets / Environments.
> Suggested Passwords entries are named `CHERR.IO – …` so you can search them.

---

## 1. Environments and URLs

| Env | Git branch | URL | Status | Chain |
|---|---|---|---|---|
| dev | `dev` | https://dev.cherr.io | live (auto-deploy on push to `dev`) | Polygon Amoy (testnet) |
| uat | `uat` | https://uat.cherr.io | not deployed yet (first push to `uat` deploys) | Polygon Amoy (separate contracts) |
| prod | `main` | https://app.cherr.io (root `cherr.io` = marketing site, ADR-042) | **not live** — manual deploy only, at launch | Polygon mainnet |

Useful paths on every env:

| Path | What |
|---|---|
| `/en` | Landing page |
| `/api/health` | Health JSON: status, env, git sha, db. Checks the auth env and runs `select 1` through PgBouncer (`DATABASE_URL`, 2 s timeout). See error codes below. |
| `/en/dev/ui` | Component gallery (dev + local only; 404 on uat/prod) |
| `/robots.txt` | `Disallow: /` on dev/uat (not indexed) |

`/api/health` answers `200 {"status":"ok","db":"ok",…}` when healthy. Otherwise `status` is `error` and Kamal keeps the previous container:

| HTTP | `error` | Meaning | Look at |
|---|---|---|---|
| 500 | `auth_config_error` | `PRIVY_APP_ID`, `PRIVY_APP_SECRET` or `SESSION_SECRET` missing/invalid | app log: `[Health] Auth configuration error` |
| 503 | `db_config_error` | `DATABASE_URL` is not set (dev/uat/prod) | GitHub Environment secrets; app log: `[Health] DATABASE_URL is not set` |
| 503 | `db_unreachable` | `select 1` through PgBouncer failed or took longer than 2 s | app log: `[Health] DB check failed`; then §3 PgBouncer config |

Locally (`APP_ENV=local`) without `DATABASE_URL` the DB check is skipped: `200` with `"db":"skipped"`.

**Admin panel:** Placeholder active at `/en/admin` (visible only to `PLATFORM_ADMIN`; 404 for others). Full admin panel arrives with TASK-021.
To grant `PLATFORM_ADMIN` to a user who has logged in with `<address>` (the user must log in once first):
```bash
ssh deploy@49.13.63.71
docker ps --filter label=service=cherrio-web-dev --format '{{.Names}}'
docker exec <container-name> node packages/db/dist/grant-admin.mjs <address>
```
Then reload `/en/admin`. Same for uat with `service=cherrio-web-uat`.

Locally (direct DB connection): `DATABASE_URL_DIRECT=... pnpm --filter @cherrio/db grant-admin <address>`

**Login does not work?** Watch the app log while logging in:
`docker logs -f --since 1m <container-name>` and look for `Session creation error`.

---

## 2. Server

| Item | Value |
|---|---|
| Provider | Hetzner Cloud, CX33 (8 GB RAM, 80 GB), Ubuntu 26.04 |
| IP | 49.13.63.71 |
| Login | `ssh deploy@49.13.63.71` (your personal SSH key; root login is disabled) |
| Emergency access | Hetzner Cloud Console → server → Console (web terminal) |
| Firewall | UFW + Hetzner Cloud Firewall: only 22, 80, 443 open |
| Repo copy of infra | `/opt/cherrio/infra/` (synced with `infra/sync.sh`) |
| Server secrets | `/opt/cherrio/secrets/infra.env` — read with `sudo cat` in your own terminal, never paste in chat |

Common commands (run after `ssh deploy@49.13.63.71`):

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}'      # all containers
docker logs -f --tail 100 $(docker ps -qf name=cherrio-web-dev)   # dev app logs
docker stats --no-stream                                  # memory per container
free -h && df -h /                                        # RAM / disk
```

Shared infra (docker compose, project `cherrio-infra`): Postgres, PgBouncer, Prometheus, Grafana, Loki, Promtail, cAdvisor, node-exporter.

**SSH under brute-force scanning.** Bots try thousands of logins per day. Passwords are off, so this is about availability: when bots fill sshd's slots, GitHub deploys fail with `Connection reset by peer`. `infra/provision/protect-ssh.sh` sets `LoginGraceTime 20`, `MaxStartups 30:30:120`, `PerSourceMaxStartups 3` and fail2ban (sshd 24 h + recidive 1 week). Re-run it after a rebuild:
```bash
bash infra/sync.sh --live                                  # on your Mac
sudo bash /opt/cherrio/infra/provision/protect-ssh.sh      # on the server
sudo fail2ban-client status sshd                           # banned IPs
sudo journalctl -u ssh --since "1 hour ago" | grep -c MaxStartups   # should stay low
```

**Multi-line paste:** if the first line is `ssh ...`, the rest is swallowed. Log in first, then paste the commands.

---

## 3. Databases

One Postgres 16 (+pgvector) with three databases. App tables live in schema `app`; the indexer writes its tables to a per-deploy schema `chain_<sha7>` and publishes read views in schema `chain` (apps read only the views); its RPC cache is `ponder_sync` (ADR-026, ADR-029; see §10).

| Env | Database | User | Password (where) |
|---|---|---|---|
| dev | `cherrio_dev` | `cherrio_dev` | `infra.env` → `POSTGRES_DEV_PASSWORD` · Passwords: `CHERR.IO – DB dev` |
| uat | `cherrio_uat` | `cherrio_uat` | `infra.env` → `POSTGRES_UAT_PASSWORD` · Passwords: `CHERR.IO – DB uat` |
| prod | `cherrio_prod` | `cherrio_prod` | `infra.env` → `POSTGRES_PROD_PASSWORD` · Passwords: `CHERR.IO – DB prod` |
| superuser | all | `postgres` | `infra.env` → `POSTGRES_SUPERUSER_PASSWORD` — use only for maintenance |

Inside the server's docker network (what the apps use):
- via PgBouncer (app traffic): `cherrio-infra-pgbouncer-1:6432`
- direct (migrations, indexer): `cherrio-infra-postgres-1:5432`

**PgBouncer config** is generated by `infra/shared/ensure-databases.sh` (run with `sudo`; it restarts PgBouncer). `userlist.txt` must contain the plain-text passwords from `infra.env`; with SCRAM verifiers only, the app fails with `server login failed: wrong password type`. Re-run after any password change:
```bash
sudo bash /opt/cherrio/infra/shared/ensure-databases.sh
docker logs --since 2m cherrio-infra-pgbouncer-1 2>&1 | tail -20
```

### TablePlus (read/debug from your Mac)

Postgres is published on the server's **loopback only** (`127.0.0.1:5432`), so it is reachable only through an SSH tunnel, never from the internet. Check: `ssh deploy@49.13.63.71 'ss -tlnp | grep 5432'` must show `127.0.0.1:5432` only.

New connection → PostgreSQL → **Over SSH**:

| Field | Value |
|---|---|
| Name | `CHERR.IO dev` (make one per env) |
| Host | `127.0.0.1` |
| Port | `5432` |
| User | `cherrio_dev` |
| Password | from Passwords `CHERR.IO – DB dev` |
| Database | `cherrio_dev` |
| SSL mode | disable (traffic is inside the SSH tunnel) |
| SSH Server | `49.13.63.71` · port `22` |
| SSH User | `deploy` |
| SSH auth | Use SSH key → your personal key (the one you use for `ssh deploy@…`) |

Tips: set the prod connection's colour to red and enable "Safe mode" in TablePlus. Use the `cherrio_*` users, not `postgres`.

---

## 4. Monitoring

| Tool | How |
|---|---|
| Grafana | `ssh -L 3000:127.0.0.1:3000 deploy@49.13.63.71` then open http://localhost:3000 · user `admin` · password `infra.env` → `GRAFANA_ADMIN_PASSWORD` (Passwords: `CHERR.IO – Grafana`) |
| Prometheus, Loki | Internal only; use Grafana data sources |

---

## 5. Backups

| Layer | Details |
|---|---|
| Hetzner server backups | Daily whole-server snapshot (Hetzner Cloud Console → server → Backups) |
| Off-site DB dumps | 02:30 UTC: `cherrio_prod` daily, `cherrio_uat` weekly (Sunday), `cherrio_dev` none (ADR-032); `pg_dump` encrypted with **age**, sent to Hetzner Storage Box `u679645` (SFTP port 23) |
| Storage Box password | Passwords: `CHERR.IO – Storage Box` (Hetzner console) |
| age private key | Passwords: `CHERR.IO – age backup key` + offline copy. **Never on the server.** |
| Restore procedure | `infra/backups/RESTORE-DRILL.md` |
| Check last backup | `ssh deploy@49.13.63.71 'systemctl list-timers cherrio-backup*; journalctl -u cherrio-backup --since today --no-pager | tail -20'` |

---

## 6. Deploys (GitHub Actions + Kamal)

| Item | Value |
|---|---|
| Repo | https://github.com/DataVallis-CHERR-IO/web3-platform (private) |
| Flow | `feat/*` → PR → `dev` (auto-deploy dev) → PR → `uat` (auto-deploy uat) → PR → `main` (prod: manual) |
| Workflow | `.github/workflows/deploy.yml` (Actions tab → "Deploy") |
| Image | `ghcr.io/datavallis-cherr-io/cherrio/web:sha-<7 chars>` |
| Kamal config | `config/deploy.yml` + `config/deploy.<env>.yml`; secrets list in `.kamal/secrets-common` (names only) |

GitHub secrets (names only — values are in GitHub):

| Scope | Names |
|---|---|
| Repository | `SSH_PRIVATE_KEY` (CI-only deploy key), `SSH_KNOWN_HOSTS`, `KAMAL_REGISTRY_USERNAME`, `KAMAL_REGISTRY_PASSWORD` (GitHub token, `read:packages`, expires in 1 year — Passwords: `CHERR.IO – GHCR pull token`) |
| Environment dev / uat | `DATABASE_URL`, `DATABASE_URL_DIRECT`; vars `APP_ENV`, `HOST` |
| Environment dev (private files) | `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `PRIVATE_FILES_KEY` — see §6.1 |
| Environment dev (indexer) | `PONDER_RPC_URL_80002` (Alchemy Amoy URL), `INDEXER_DATABASE_URL` (role `cherrio_indexer_dev`, direct Postgres) — see §10 |
| Environment prod | empty until launch; restricted to branch `main` |

Rollback: Actions → re-run the "Deploy" workflow of the last good commit, or on your Mac with the env vars exported: `kamal rollback -d dev sha-<good>`.

### 6.1 Private file storage (KYB documents, ADR-033)

| Item | dev | uat / prod |
|---|---|---|
| Bucket (Hetzner Console → Object Storage) | `cherrio-private-dev`, private, location `nbg1` | not created yet |
| Endpoint / region (not secret, in `config/deploy.dev.yml`) | `https://nbg1.your-objectstorage.com` / `nbg1` | — |
| Access key pair | GitHub Environment `dev`: `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | — |
| File encryption key | GitHub Environment `dev`: `PRIVATE_FILES_KEY`; Passwords: `CHERR.IO – private files key dev` | generate one per environment: `openssl rand -base64 32` |

- **If `PRIVATE_FILES_KEY` is lost, every stored file of that environment is unreadable.** There is no backup of the bucket yet. Never change the key of an environment that already holds files.
- Every web deploy ends with a storage check (`files:check`); if it fails, the deploy job is red although the site is up — read the step's log, it names the cause without printing values.
- By hand on the server (`docker ps --filter label=service=cherrio-web-dev`):
  - `docker exec <container> node apps/web/dist/files.mjs check`
  - `docker exec <container> node apps/web/dist/files.mjs sweep --dry-run`, then `… sweep` — **weekly**, until the worker does it.
- **Public media bucket (ADR-037):** `cherrio-public-dev`, **public read**, location `nbg1`, same access key. Base URL (not secret, in `config/deploy.dev.yml`): `https://cherrio-public-dev.nbg1.your-objectstorage.com`. Only campaign cover images; never personal documents. No sweep yet. uat / prod: not created.
- Locally the same storage is the `s3mock` container from `docker-compose.dev.yml` (`127.0.0.1:9090`, bucket `cherrio-private-local`, empty after a restart).

---

## 7. Smart contracts

### amoy-dev (deployed 2026-10-01, block ~49017100, cost 0.27 POL)

| Contract | Address |
|---|---|
| PlatformConfig | [`0x4d2570ccB2a6653D62a002027C0d383FfB193A16`](https://amoy.polygonscan.com/address/0x4d2570ccB2a6653D62a002027C0d383FfB193A16) |
| Campaign implementation | [`0x6F6A9F54cC48a13bC5bFc127d16D874D07ccEA8F`](https://amoy.polygonscan.com/address/0x6F6A9F54cC48a13bC5bFc127d16D874D07ccEA8F) |
| CampaignFactory | [`0xd5Ca76A8FC6E15C6cC3F3C691A2b6c70D9715a00`](https://amoy.polygonscan.com/address/0xd5Ca76A8FC6E15C6cC3F3C691A2b6c70D9715a00) |
| EmergencyPool | [`0xFa7Fd0253813E196d74575A8F93ABB91cd009517`](https://amoy.polygonscan.com/address/0xFa7Fd0253813E196d74575A8F93ABB91cd009517) |
| TimelockController (5 min delay) | [`0x52ba2090E62c9155c04E7E5f28DB9Af00A6AAede`](https://amoy.polygonscan.com/address/0x52ba2090E62c9155c04E7E5f28DB9Af00A6AAede) |
| Operator + Guardian + Timelock proposer/executor + treasury | `0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7` (testnet EOA) |

Source of truth for code: `packages/contracts/deployments/amoy-dev.json`.

**Publishing campaigns (TASK-010c):** the operator EOA above signs `createCampaign` from `/en/admin/campaigns/[id]` in the browser. It must be connected to the admin's CHERR.IO account (Account → Wallets) and hold some Amoy POL for gas. Runbook: `docs/technical/08-operations.md` §5.1b. One publish costs about 332,000 gas (≈ 0.01 POL at 30 gwei; first campaign `0xf397a197d96426f44b1c236c28049ced4d3691c7`, 2026-10-02).

### amoy-uat / polygon

Not deployed. uat is deployed at the first dev → uat promotion (own contracts, ADR-020). Mainnet uses a Safe and the 48 h timelock (TASK-023 runbook).

### Token addresses

| Token | Network | Address |
|---|---|---|
| USDC (native, Circle) | Polygon mainnet | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` |
| USDC (Circle testnet) | Polygon Amoy | `0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582` |
| CHR (Polygon PoS child) | Polygon mainnet | `0xfcfE798Dfb904f096c8e010F1254710E17AF1F81` |
| CHR (original) | Ethereum mainnet | `0x385F…745b` (full address in ADR-006 source) |

Explorers: https://amoy.polygonscan.com · https://polygonscan.com

### 7.1 Testnet (Polygon Amoy, chain id 80002)

| Item | Value |
|---|---|
| Testnet deployer / admin wallet | `0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7` (testnet only — never use on mainnet) |
| RPC | `https://polygon-amoy.g.alchemy.com/v2/<ALCHEMY_KEY>` — key in Passwords: `CHERR.IO – Alchemy Amoy key` |
| Alchemy dashboard | https://dashboard.alchemy.com |
| Public fallback RPC | `https://rpc-amoy.polygon.technology` |

Faucets (limits change; usually once per 24 h per address):

| Token | Faucet |
|---|---|
| POL (gas) | https://faucet.polygon.technology (official) |
| POL (gas) | https://www.alchemy.com/faucets/polygon-amoy |
| POL (gas) | https://faucet.quicknode.com/polygon/amoy |
| USDC (test) | https://faucet.circle.com → network "Polygon PoS Amoy" |

Deploying all contracts once costs roughly 0.3–0.5 POL; keep ≥1 POL on the deployer for dev + uat.

---

### 7.2 How to deploy contracts to Amoy (step by step)

Use this when contracts change (they are not upgradeable: a change = a new deployment with new addresses) or when deploying uat for the first time.

**Before you start (once):**
- Testnet wallet `0x4326…B5a7` has ≥1 POL (faucets above). A full deploy costs ≈0.3 POL.
- Etherscan API key (etherscan.io → API Keys; one key works for Amoy). Passwords: `CHERR.IO – Etherscan API key`.
- Alchemy Amoy key. Passwords: `CHERR.IO – Alchemy Amoy key`.
- Testnet wallet private key: MetaMask → account `0x4326…B5a7` → ⋮ → Account details → Show private key. **It must start with `0x`** (add it if MetaMask shows it without).
- You are on the branch that has the contract code you want to deploy, and `forge test` is green.

**1. Open a new terminal and set everything (one terminal from start to end):**

```bash
cd ~/Documents/Development/CHERR.IO/packages/contracts
unset HISTFILE                      # nothing from this session goes to shell history

export ALCHEMY_AMOY_URL="https://polygon-amoy.g.alchemy.com/v2/PASTE_ALCHEMY_KEY"
export SAFE_ADDRESS=0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7
export TREASURY_ADDRESS=0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7
export DEPLOY_NAME=dev               # or uat
export TIMELOCK_DELAY=300
export POLYGONSCAN_API_KEY="PASTE_ETHERSCAN_KEY"
export COMMIT_SHA=$(git rev-parse --short HEAD)
```

No brackets or quotes around the URL other than the ones shown.

**2. Enter the private key (it is not shown while you paste):**

```bash
read -s DEPLOYER_PRIVATE_KEY
```
Press Enter, paste the key (with `0x`), press Enter again. Then:
```bash
export DEPLOYER_PRIVATE_KEY
```

**3. Check key and balance:**

```bash
cast wallet address $DEPLOYER_PRIVATE_KEY      # must print 0x432696A5…B5a7
cast balance 0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7 --rpc-url $ALCHEMY_AMOY_URL --ether   # ≥ 0.5
```

**4. Dry run (simulation, sends nothing, writes nothing):**

```bash
forge script script/DeployAmoy.s.sol --rpc-url $ALCHEMY_AMOY_URL
```
Must end with `SIMULATION COMPLETE`. Ignore the gas price it estimates (Amoy needs ≥25 gwei; we set it in step 5) and the EIP-3855 warning.

**5. Real deploy + verification:**

```bash
forge script script/DeployAmoy.s.sol \
  --rpc-url $ALCHEMY_AMOY_URL \
  --broadcast \
  --slow \
  --with-gas-price 35gwei \
  --priority-gas-price 30gwei \
  --verify --chain 80002 \
  --etherscan-api-key $POLYGONSCAN_API_KEY
```
Success = `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL` and `Wrote: deployments/amoy-<name>.json`.
"Verification is still pending" for some contracts is normal (Polygonscan queue) — see step 7.

**6. Close the terminal** (the key disappears from memory).

**7. Check on amoy.polygonscan.com** (open each address from the JSON file):
- every contract shows a green ✓ "Contract Source Code Verified" tab;
- PlatformConfig → Read Contract → `hasRole(DEFAULT_ADMIN_ROLE = 0x00…00, <timelock>)` = true, `hasRole(0x00…00, 0x4326…)` = false, `emergencyPool` = pool address, `treasury` = `0x4326…`.

If a contract is still not verified after ~10 minutes, verify it manually (new terminal, export `POLYGONSCAN_API_KEY` only):
```bash
cd ~/Documents/Development/CHERR.IO/packages/contracts
forge verify-contract <ADDRESS> <path:Contract> --chain 80002 \
  --etherscan-api-key $POLYGONSCAN_API_KEY --watch \
  --constructor-args <hex from the deploy log line "Constructor args:", with 0x prefix>
```
`<path:Contract>` examples: `src/PlatformConfig.sol:PlatformConfig`, `lib/openzeppelin-contracts/contracts/governance/TimelockController.sol:TimelockController`.

**8. Commit the addresses:**

```bash
cd ~/Documents/Development/CHERR.IO
git status        # broadcast/ and cache/ must NOT be listed (cache/ holds sensitive values)
git add packages/contracts/deployments/amoy-<name>.json
git commit -m "chore(contracts): deploy amoy-<name>"
```
Then PR → `dev`. Update the table in §7 of this file.

**Troubleshooting**
- `vm.writeFile ... not allowed` → `foundry.toml` needs `fs_permissions = [{ access = "read-write", path = "./deployments" }]`. Nothing is sent when this happens (the simulation fails before broadcast).
- `zsh: not an identifier` → you typed the key after `read -s`; type only `read -s DEPLOYER_PRIVATE_KEY`, then paste.
- `transaction underpriced` → raise `--with-gas-price` / `--priority-gas-price`.
- "Detected artifacts built from source files that no longer exist" → harmless; `forge clean` removes it.

---

## 8. External accounts (created later)

| Service | Used for | Task |
|---|---|---|
| Privy | Login + embedded wallets | TASK-025 |
| Alchemy | RPC + Gas Manager | TASK-006 / 011 |
| Sumsub | KYC for individuals | TASK-009 |
| Transak | Card on-ramp | TASK-012 |
| Hetzner Object Storage | Private files (KYB, evidence) — dev bucket created, see §6.1 | TASK-008 |

Add a row with the dashboard URL and the Passwords entry name when each account is created.

---

## 9. Open items

- [ ] Hetzner Cloud Firewall: confirm it is created and applied to the server.
- [ ] Repeat the restore drill after the first successful migration on dev (real tables).
- [ ] Deploy amoy-uat at the first dev → uat promotion.
- [x] `/api/health` should also check the database, so a deploy with a broken DB connection is not marked healthy.
- [ ] Privy: create a separate Privy app for prod before launch (allowed origin `https://app.cherr.io`).
- [ ] MacBook Air: remove the Homebrew `postgresql@17`/`pgvector` an earlier agent installed, if not needed (`brew uninstall postgresql@17 pgvector`).
- [ ] Indexer: first deploy to dev (§10.1) and paste the acceptance outputs into `docs/tasks/TASK-026.feedback.md`.
- [ ] Indexer: uat/prod need `config/indexer.<env>.yml`, a role password in `infra.env` and the two GitHub secrets (§10.1); prod RPC secret is `PONDER_RPC_URL_137`.

---

## 10. Indexer (Ponder)

One indexer per environment, a separate Kamal service (`config/indexer.yml` + `config/indexer.<env>.yml`), image `ghcr.io/datavallis-cherr-io/cherrio/indexer:sha-<7 chars>`. It has **no public URL and no published port**; it is reachable only inside the server's Docker network as `cherrio-indexer-dev:42069`.

| Item | Value |
|---|---|
| Tables | schema `chain_<sha7>` (one per deployed commit) |
| What apps read | views in schema `chain` — never `chain_<sha7>` directly (ADR-026) |
| RPC cache | schema `ponder_sync` |
| DB role | `cherrio_indexer_dev`, direct Postgres, limit 10 connections, no access to schema `app` |
| Deploys | "Deploy" workflow, job "Indexer" — only when `apps/indexer`, `packages/contracts`, `packages/shared`, `pnpm-lock.yaml`, `Dockerfile.indexer`, `config/indexer*.yml` or the workflow changed. To force a deploy: push a commit that changes an indexer input (`apps/indexer/**`, `packages/contracts/**`, `packages/shared/**`, `pnpm-lock.yaml`, `Dockerfile.indexer`, `config/indexer*.yml` or `.github/workflows/deploy.yml`). The "Run workflow" button is not shown in GitHub Actions because `deploy.yml` is not on the default branch `main`; it appears once the file is on `main` (David's decision). |
| Deploy job steps | build → Kamal deploy → wait for `/ready` (max 20 min) → reconcile → prune |
| Memory limit | 384 MB (`NODE_OPTIONS=--max-old-space-size=288`) |

### 10.1 First-time setup per environment (dev shown)

1. **Role password.** Create a password (Passwords: `CHERR.IO – DB indexer dev`) and add it on the server to `/opt/cherrio/secrets/infra.env` as `POSTGRES_INDEXER_DEV_PASSWORD=...` (letters and digits only keeps the URL in step 4 simple).
2. **Sync infra and look first:**
   ```bash
   bash infra/sync.sh --live                                              # on your Mac
   sudo bash /opt/cherrio/infra/shared/ensure-databases.sh --dry-run     # on the server: prints, changes nothing
   ```
3. **Apply.** ⚠️ This also changes PgBouncer (pool 20 → 14, reserve 5 → 2), sets the web roles' limit to 18 (new for prod) and **restarts PgBouncer: dev, uat and prod apps lose their DB connections for a few seconds** and reconnect on their own. Do it when nobody is testing.
   ```bash
   sudo bash /opt/cherrio/infra/shared/ensure-databases.sh
   docker logs --since 2m cherrio-infra-pgbouncer-1 2>&1 | tail -20
   curl -s https://dev.cherr.io/api/health          # must show "db":"ok"
   ```
4. **GitHub → Settings → Environments → dev → secrets:**
   - `PONDER_RPC_URL_80002` = `https://polygon-amoy.g.alchemy.com/v2/<ALCHEMY_KEY>`
   - `INDEXER_DATABASE_URL` = `postgres://cherrio_indexer_dev:<password>@cherrio-infra-postgres-1:5432/cherrio_dev`
5. **`.kamal/secrets-common`** — add these two lines (names only, like the others):
   ```
   PONDER_RPC_URL_80002=$PONDER_RPC_URL_80002
   INDEXER_DATABASE_URL=$INDEXER_DATABASE_URL
   ```
6. Merge to `dev` and watch the job "Indexer". It runs only when an indexer input changed (see the table above for how to force it).

### 10.2 Daily commands (on the server)

```bash
C=$(docker ps -qf name=cherrio-indexer-dev)                   # the running indexer container

docker logs -f --tail 100 $C                                  # logs
docker exec $C wget -qO- http://127.0.0.1:42069/status        # indexed block per chain
docker exec $C wget -q -S -O /dev/null http://127.0.0.1:42069/ready 2>&1 | head -1   # 200 = backfill done
docker exec $C node dist/reconcile.mjs                        # compare with the contracts; exit 1 on mismatch
docker exec $C node dist/prune.mjs --dry-run                  # what prune would drop
docker exec $C node dist/prune.mjs                            # drop old chain_<sha7> (keeps live + one previous)
docker stats --no-stream $C                                   # memory (limit 384 MB)
docker port $C                                                # must print nothing (no published port)
```

`/ready` turns 200 when the backfill has reached the finalized block; the last ~30 blocks follow within seconds. Reconcile always compares at the block the indexer has reached, so it is safe to run at any time.

### 10.3 Checks with SQL

```bash
PSQL="docker exec -i cherrio-infra-postgres-1 psql -U postgres -d cherrio_dev"

# Schemas and which one the chain views read from
$PSQL -c "select nspname, pg_get_userbyid(nspowner) from pg_namespace where nspname like 'chain%' or nspname = 'ponder_sync'"

# Web role: may read the views, nothing else
$PSQL -c "set role cherrio_dev; select count(*) from chain.campaign"         # works
$PSQL -c "set role cherrio_dev; update chain.pool set balance = 0"           # ERROR: permission denied

# Indexer role: no access to app
$PSQL -c "set role cherrio_indexer_dev; select * from app.users limit 1"     # ERROR: permission denied for schema app

# Connections per role (budget: web 18, indexer 10)
docker exec -i cherrio-infra-postgres-1 psql -U postgres -c "select usename, count(*) from pg_stat_activity where usename like 'cherrio%' group by 1 order by 1"
```

From outside, `https://dev.cherr.io/sql` and `/graphql` must return the web app's 404.

### 10.4 Rollback, restart, re-index

- **Restart / crash:** the container restarts by itself and resumes from its checkpoint (`Detected crash recovery` in the log). A restart of the same version waits about 25 s for the old lock first.
- **Rollback** (on your Mac, with the registry and the two indexer secrets exported): `kamal rollback -c config/indexer.yml -d dev sha-<previous>`. The previous schema is still there (prune keeps one), so the old version resumes from its checkpoint and the `chain` views switch back to it when it is ready. Until then the views show the newer schema's last state. Rolling back further than one version is a full re-index.
- **Re-index the current version from scratch** (only if its data is suspect; the views are gone until `/ready`, so pages that read `chain.*` fail meanwhile):
  ```bash
  C=$(docker ps -qf name=cherrio-indexer-dev); docker stop $C
  docker exec -i cherrio-infra-postgres-1 psql -U postgres -d cherrio_dev -c 'DROP SCHEMA "chain_<sha7>" CASCADE'
  docker start $C
  ```
  The RPC cache (`ponder_sync`) is kept, so this is fast. Drop `ponder_sync` as well only if the cache itself is suspect.
- **"too many connections for role cherrio_indexer_dev" during a deploy:** the old and the new version overlap for a moment (7 of 10 connections measured locally; the theoretical worst case is 12). If it ever fails, stop the old one first: `docker stop $(docker ps -qf name=cherrio-indexer-dev)`, then re-run the deploy.

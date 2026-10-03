# Runbook — first uat and prod launch

Last updated: 2026-10-03 · Owner: David (Data Vallis d.o.o.) · Guide: Claude (CTO session)

This is the step-by-step list for the day David says "we deploy to prod". Claude walks David through it in order and ticks every box. Every secret is **created by David, stored in his password manager under the entry name given here, and pasted only into the place named here**: GitHub Environment secrets, the server's `/opt/cherrio/secrets/infra.env`, or a terminal variable that is gone when the terminal closes. **No value ever goes into chat, the repo, a commit, a log or a screenshot.** Claude never sees values; it gives the commands and checks the results that contain no secrets.

Status of this runbook: **Planned**. Nothing here has been run yet. Part 0 lists the code that must be merged before Part C can work.

Order: **Part 0** (code, Claude) → **Part A** (uat, once) → **Part B** (prod accounts and secrets, David) → **Part C** (prod deploy) → **Part D** (checks) → **Part E** (after launch). Rollback is at the end.

---

## Part 0 — code that must be merged first (Claude, PRs to `dev`, then promoted)

Each item is a PR with tests. Claude does these when David schedules the launch.

| # | What | Why |
|---|---|---|
| 0.1 | `config/deploy.prod.yml`: the prod Privy App ID (not a secret; David gives it after B.1); the S3 settings for `cherrio-private-prod` and `cherrio-public-prod` (same keys as `config/deploy.dev.yml`); the S3 and `PRIVATE_FILES_KEY` secrets in its `secret:` list | Today prod has only DB, Privy and session settings. Uploads, KYB documents and campaign media would fail, and the deploy's storage check would be skipped |
| 0.2 | The same for `config/deploy.uat.yml` (`cherrio-private-uat`, `cherrio-public-uat`, the uat Privy App ID = the shared testnet app) | uat must work like dev before it can prove prod |
| 0.3 | `config/indexer.uat.yml` and `config/indexer.prod.yml` (copies of `indexer.dev.yml`: service, alias, `APP_ENV`, and for prod the secret `PONDER_RPC_URL_137`) | No indexer means no campaign can be linked or shown as live |
| 0.4 | **Mainnet publishing through the Safe** (TASK-023) | On mainnet `OPERATOR_ROLE` belongs to the Safe (`DeployPolygon.s.sol`), not to a browser wallet. The "Publish on Polygon" button of dev signs with one wallet. Prod needs a "propose to Safe" flow, or a decision to give a separate operator wallet `OPERATOR_ROLE`. **David decides before the launch.** |
| 0.5 | TASK-023 items: Slither in CI, restore drill with real tables, Hetzner Cloud Firewall confirmed, admin MFA decision | Launch criteria in `docs/technical/06-security.md` §11 |
| 0.6 | `packages/contracts/deployments/amoy-uat.json` and `polygon.json` committed after A.3 / C.2 | The app and the indexer read contract addresses from these files |

---

## Part A — uat, the first time (testnet; needed before prod)

uat is the dress rehearsal: same steps as prod, on Amoy, no real money.

**A.1 Privy.** One shared testnet app for dev + uat (decided 2026-10-03). `https://uat.cherr.io` is already an allowed origin (David, 2026-10-03). The uat App ID is the same as dev's. Claude sets it in 0.2.

**A.2 Hetzner Object Storage** (Hetzner Console → Object Storage → Create bucket, location `nbg1`):
- `cherrio-private-uat`: **private**.
- `cherrio-public-uat`: **public read**.
- The access key pair can be the dev pair (same storage account).

**A.3 Contracts on Amoy for uat.** Follow `docs/CHEATSHEET.md` §7.2 exactly, with `export DEPLOY_NAME=uat`. Commit `deployments/amoy-uat.json` (PR → `dev`).

**A.4 Secrets.** Generate each value on the Mac. The output goes straight into the password manager, not into chat:
```bash
openssl rand -base64 48 | tr -d '\n'   # SESSION_SECRET            → Passwords: "CHERR.IO – session secret uat"
openssl rand -base64 32 | tr -d '\n'   # PRIVATE_FILES_KEY         → Passwords: "CHERR.IO – private files key uat"
openssl rand -hex 24                   # DB password (web role)    → Passwords: "CHERR.IO – DB uat"
openssl rand -hex 24                   # DB password (indexer)     → Passwords: "CHERR.IO – DB indexer uat"
```
Use hex for DB passwords so the connection URLs need no escaping.

**A.5 Server: roles and databases.** If `POSTGRES_UAT_PASSWORD` is already in `infra.env`, keep it; it is the existing uat DB password. Add only the indexer password.
```bash
ssh deploy@<server>                      # address: Passwords "CHERR.IO – server"
sudo nano /opt/cherrio/secrets/infra.env # add: POSTGRES_INDEXER_UAT_PASSWORD=<from A.4>
exit
bash infra/sync.sh --live                                              # on the Mac, repo root
ssh deploy@<server>
sudo bash /opt/cherrio/infra/shared/ensure-databases.sh --dry-run      # read it; changes nothing
sudo bash /opt/cherrio/infra/shared/ensure-databases.sh               # ⚠ restarts PgBouncer for a few seconds
curl -s https://dev.cherr.io/api/health                                # "db":"ok"
```

**A.6 GitHub → Settings → Environments → `uat` → Environment secrets.**

| Secret | Value |
|---|---|
| `DATABASE_URL` | `postgres://cherrio_uat:<DB uat>@cherrio-infra-pgbouncer-1:6432/cherrio_uat` |
| `DATABASE_URL_DIRECT` | `postgres://cherrio_uat:<DB uat>@cherrio-infra-postgres-1:5432/cherrio_uat` |
| `PRIVY_APP_SECRET` | the testnet app's secret (same as dev) |
| `SESSION_SECRET` | A.4 (its own, never dev's) |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | storage key pair |
| `PRIVATE_FILES_KEY` | A.4 |
| `PONDER_RPC_URL_80002` | `https://polygon-amoy.g.alchemy.com/v2/<Alchemy key>` |
| `INDEXER_DATABASE_URL` | `postgres://cherrio_indexer_uat:<DB indexer uat>@cherrio-infra-postgres-1:5432/cherrio_uat` |

If existing secrets were created at an earlier setup, check their names against the table.

**A.7 Promote.** Open a GitHub PR `dev` → `uat`; the promotion guard checks the source branch. Merge it when CI is green. The Deploy workflow deploys web + indexer to uat.

**A.8 Check uat**, as in Part D but with `uat.cherr.io`. Then do one full test run: an organisation → KYB → a campaign → review → publish on Amoy → Live.

---

## Part B — prod accounts and secrets (David)

Do these a few days before the launch. Every row creates a password-manager entry.

| # | Account / value | Where to create it | Passwords entry |
|---|---|---|---|
| B.1 | **Privy prod app** "CHERR.IO prod": allowed origin `https://app.cherr.io`; login methods email, Google, external wallets; embedded wallets on **Polygon mainnet** | dashboard.privy.io → New app | "CHERR.IO – Privy prod" (App ID + App secret). Give Claude the **App ID only** (it is public) for 0.1 |
| B.2 | **Alchemy mainnet app** (Polygon PoS mainnet) and its key | dashboard.alchemy.com → Create app | "CHERR.IO – Alchemy Polygon key" |
| B.3 | **Gnosis Safe on Polygon** (contract owner + operator + guardian). Suggested: 2-of-3 signers on hardware wallets | app.safe.global → Create Safe → Polygon | "CHERR.IO – Safe Polygon" (address + signers) |
| B.4 | **Treasury address** (receives the 1 % fee); can be the Safe | — | in the Safe entry |
| B.5 | **Mainnet deployer wallet**: a new, empty EOA used only for the deploy, with ~20 POL for gas (holds no roles afterwards) | MetaMask → new account | "CHERR.IO – mainnet deployer" |
| B.6 | Hetzner buckets `cherrio-private-prod` (**private**) and `cherrio-public-prod` (**public read**), `nbg1`. Prefer a **separate access key pair** for prod | Hetzner Console → Object Storage | "CHERR.IO – S3 prod keys" |
| B.7 | Generated secrets: `SESSION_SECRET` (`openssl rand -base64 48`), `PRIVATE_FILES_KEY` (`openssl rand -base64 32`), DB web password (`openssl rand -hex 24`), DB indexer password (`openssl rand -hex 24`) | Mac terminal | "CHERR.IO – session secret prod", "– private files key prod", "– DB prod", "– DB indexer prod" |
| B.8 | Etherscan API key (already exists; works for Polygon) | etherscan.io | "CHERR.IO – Etherscan API key" |
| B.9 | DNS: `app.cherr.io` A record → server (done, David 2026-10-03) | registrar | — |

**`PRIVATE_FILES_KEY` (prod) must never be lost or changed.** Without it every stored KYB document is unreadable. Keep a second copy offline.

---

## Part C — prod deploy (launch day)

**C.1 Freeze.** No merges to `dev` until the end of C.

**C.2 Contracts on Polygon mainnet** (David's Mac, one terminal start to end, `forge test` green on `main`'s commit):
```bash
cd ~/Documents/Development/CHERR.IO/packages/contracts
git checkout main && git pull
unset HISTFILE
export ALCHEMY_POLYGON_URL="https://polygon-mainnet.g.alchemy.com/v2/PASTE_KEY"   # B.2
export SAFE_ADDRESS=0x...            # B.3
export TREASURY_ADDRESS=0x...        # B.4
export POLYGONSCAN_API_KEY="PASTE"   # B.8
export COMMIT_SHA=$(git rev-parse --short HEAD)
read -s DEPLOYER_PRIVATE_KEY         # paste the B.5 key (with 0x), Enter
export DEPLOYER_PRIVATE_KEY
cast wallet address $DEPLOYER_PRIVATE_KEY                                  # = B.5 address
cast balance <B.5 address> --rpc-url $ALCHEMY_POLYGON_URL --ether          # ≥ 10
forge script script/DeployPolygon.s.sol --rpc-url $ALCHEMY_POLYGON_URL     # simulation: "SIMULATION COMPLETE"
forge script script/DeployPolygon.s.sol --rpc-url $ALCHEMY_POLYGON_URL \
  --broadcast --slow --verify --chain 137 --etherscan-api-key $POLYGONSCAN_API_KEY
```
- Success: `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL` and `Wrote: deployments/polygon.json`. **Close the terminal.**
- Check on polygonscan.com: every contract is verified. PlatformConfig `hasRole(DEFAULT_ADMIN_ROLE, timelock)` = true, `hasRole(OPERATOR_ROLE, Safe)` = true, the deployer has no roles, `usdc()` = `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`, the timelock delay = 48 h.
- Commit `deployments/polygon.json` (git status must not list `broadcast/` or `cache/`). Then PR → `dev`, and promote it like everything else.

**C.3 Server: prod roles.** `POSTGRES_PROD_PASSWORD` should already be in `infra.env`, because `ensure-databases.sh` requires it and has created `cherrio_prod`. Check with `sudo grep -c '^POSTGRES_PROD_PASSWORD=' /opt/cherrio/secrets/infra.env`, which prints `1` and no value. Its value is the "DB prod" password in C.4; if it is not in the password manager, set a new one in `infra.env` (the script updates the role). Add `POSTGRES_INDEXER_PROD_PASSWORD=<B.7>`, then run sync + `ensure-databases.sh` as in A.5.

**C.4 GitHub → Settings → Environments → `prod`** (restricted to branch `main`). Secrets:

| Secret | Value |
|---|---|
| `DATABASE_URL` | `postgres://cherrio_prod:<DB prod>@cherrio-infra-pgbouncer-1:6432/cherrio_prod` |
| `DATABASE_URL_DIRECT` | `postgres://cherrio_prod:<DB prod>@cherrio-infra-postgres-1:5432/cherrio_prod` |
| `PRIVY_APP_SECRET` | B.1 |
| `SESSION_SECRET` | B.7 |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | B.6 |
| `PRIVATE_FILES_KEY` | B.7 |
| `PONDER_RPC_URL_137` | `https://polygon-mainnet.g.alchemy.com/v2/<B.2>` |
| `INDEXER_DATABASE_URL` | `postgres://cherrio_indexer_prod:<DB indexer prod>@cherrio-infra-postgres-1:5432/cherrio_prod` |

Recommended: Environment `prod` → "Required reviewers" = David, so nothing deploys to prod without his click.

**C.5 Promote** `uat` → `main` (GitHub PR, CI green, merge). Prod does **not** deploy automatically.

**C.6 Deploy.** GitHub → Actions → **Deploy** → "Run workflow" → branch `main`, environment `prod`. The button exists once `deploy.yml` is on `main`. Approve the environment if you set required reviewers. Watch three jobs:
- **Build → Deploy → Migrate**: all steps green, including "Run DB migrations", the smoke tests, and "Check private file storage";
- **Indexer**: Ready, Reconcile with 0 mismatches;
- **Create release tag** (prod only).

---

## Part D — checks after the deploy (David clicks, Claude reads the results)

1. `https://app.cherr.io/api/health` → `"status":"ok"`, `"db":"ok"`.
2. `https://app.cherr.io/en` loads; the response has **no** `X-Robots-Tag: noindex` (prod only).
3. Log in with email → the account page opens; log out.
4. Grant yourself platform admin (log in once first):
   ```bash
   ssh deploy@<server>
   docker ps --filter label=service=cherrio-web-prod --format '{{.Names}}'
   docker exec <container> node packages/db/dist/grant-admin.mjs <your wallet address>
   ```
   Then open `/en/admin`.
5. `https://cherr.io` still shows the marketing site (separate service).
6. Backups: the next morning, check that the 02:30 UTC prod dump ran (`docs/CHEATSHEET.md` §5).
7. Update `docs/CHEATSHEET.md` §1, §6, §7 and §9 and `docs/technical/09-status-and-roadmap.md` (Claude, docs-only PR).

---

## Part E — after launch

- Close CHEATSHEET §9 items, and keep the password manager entries current.
- Watch the logs for `[fx]` and `[campaign.link]` messages for a day (`docs/technical/08-operations.md`).
- First real campaign: KYB → review → publish through the Safe flow (0.4).

---

## Rollback

- **Web app:** GitHub → Actions → Deploy → re-run the last good prod run. Or on the Mac with the prod secrets exported: `kamal rollback -d prod sha-<good>`.
- **Migrations** are backward compatible (expand → migrate → contract), so the previous image works with the new schema.
- **Contracts are not upgradeable.** A broken contract is paused with the Guardian (`freeze`) through the Safe. A fix is a new deployment and a new `polygon.json`.
- **Never** reset or delete `cherrio_prod` or the prod buckets.

Sources: `docs/CHEATSHEET.md` §1, §5–§10; `config/deploy*.yml`; `config/indexer*.yml`; `.github/workflows/deploy.yml`; `infra/shared/ensure-databases.sh`; `packages/contracts/README.md` (Polygon mainnet); `packages/contracts/script/DeployPolygon.s.sol`; ADR-020, ADR-023, ADR-024, ADR-033, ADR-037, ADR-042.

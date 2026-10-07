# CHERR.IO — Technical Architecture (v2)

## 1. System overview

```
             ┌──────────── Browser ────────────┐
             │ Next.js UI · Privy · wagmi/viem │
             │ Transak widget · donate widget   │
             └──────┬───────────────┬───────────┘
                    │ HTTPS         │ JSON-RPC (Alchemy) + bundler/paymaster
             ┌──────▼──────┐        │
             │  apps/web   │        │
             │ SSR + REST  │        ▼
             │ + admin     │   Polygon PoS ── CampaignFactory · Campaign clones
             └──┬───────┬──┘                  EmergencyPool · PlatformConfig · Timelock
                │       │                         │ events
         ┌──────▼─┐  ┌──▼──────┐           ┌──────▼──────┐
         │Postgres│◀─│ worker  │           │ apps/indexer │ (Ponder)
         │pgvector│  │ BullMQ  │           └──────┬──────┘
         └──▲─────┘  └──┬──────┘                  │ writes chain tables
            │ PgBouncer │ Redis                   │
            └───────────┴─────────────────────────┘
   Private files: Hetzner Object Storage (encrypted)   Public files: PollinationX / Pinata
   External: Sumsub (KYC) · Transak (onramp) · Privy (auth/wallets) · Alchemy (RPC, gas manager)
```

## 2. Smart contracts (`packages/contracts`)

### 2.1 Contracts
| Contract | Type | Purpose |
|---|---|---|
| `PlatformConfig` | singleton | Roles, USDC address, fee bps (100 = 1%), success threshold bps (1000), vote window (7 days, ADR-045), quorum bps (2500, ADR-045), approval bps (5100), treasury address, refund-sweep delay (180 days) |
| `CampaignFactory` | singleton | Deploys `Campaign` via EIP-1167 clones on admin approval; registry of campaigns |
| `Campaign` | clone per campaign | Escrow, donations, end/finalize, payout (SINGLE/MILESTONES), voting, refunds, freeze |
| `EmergencyPool` | singleton | Sub-pool accounting (`poolId → balance`), direct donations, allocation proposals + votes |
| `TimelockController` | OZ | Admin actions delayed 48 h on mainnet; 5 min on Amoy (ADR-025) |

- **Non-upgradeable.** New versions = new factory; old campaigns finish on old code. (ADR-009)
- Solidity ^0.8.24, OpenZeppelin v5, `SafeERC20`, `ReentrancyGuard`, checks-effects-interactions, pull payments.

### 2.2 Roles (OZ AccessControl in `PlatformConfig`)
| Role | Holder | Powers |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | TimelockController (proposer/executor = Safe) | grant/revoke roles, config changes |
| `OPERATOR_ROLE` | Backend relayer (KMS-held key, Phase 1 may be Safe) | create approved campaigns, set payout mode at finalize, create sub-pools |
| `GUARDIAN_ROLE` | Safe (direct, no timelock) | `freeze`, `resolve` in NEEDS_REVIEW/FROZEN |

Safe: currently 1 owner (David) with 2 keys he controls (hardware + backup), threshold 1-of-2; more signers added later without moving funds.

### 2.3 `Campaign` state machine
Nine states (`Campaign.sol`): `LIVE, SUCCEEDED, FAILED, PAYING, COMPLETED, VOTING, NEEDS_REVIEW, REJECTED, FROZEN`. There are no per-round states; the round is the counter `currentRound`. Full diagram: `docs/technical/02-smart-contracts.md` §3.2.
```
LIVE → SUCCEEDED         the target is reached (finalizes inside donate), or finalize() after the deadline with ≥ 10% raised
LIVE → FAILED            finalize() after the deadline with < 10% raised
SUCCEEDED → COMPLETED    release(), SINGLE: all at once, 72 h after the end (ADR-031)
SUCCEEDED → PAYING       release(), MILESTONES: tranche 1 + the full fee
PAYING → VOTING          submitEvidence() by the beneficiary
VOTING → PAYING          closeVote(): quorum + approval met, tranche 2 released in the same call
VOTING → COMPLETED       closeVote(): quorum + approval met, tranche 3 released in the same call
VOTING → NEEDS_REVIEW    closeVote(): no quorum → Guardian: resolve(true) releases the tranche, resolve(false) → REJECTED
VOTING → REJECTED        closeVote(): quorum met, approval not met (remaining → donors' preference)
LIVE | SUCCEEDED | PAYING | VOTING | NEEDS_REVIEW → FROZEN (Guardian)
FROZEN → previous state  resolve(true);  FROZEN → REJECTED  resolve(false)
```

Key functions (indicative; exact signatures defined in tasks):
- `donate(uint256 amount, Preference pref, uint32 subPoolId)` — clips to remaining; records `donated[donor]`, `totalRaised`.
- `setPreference(Preference, uint32 subPoolId)` — until end.
- `finalize()` — callable by anyone once the deadline has passed; sets SUCCEEDED/FAILED. Reaching the target needs no call: it finalizes inside `donate`.
- `setPayoutMode(Mode)` — OPERATOR, only in SUCCEEDED before first release (based on off-chain rating).
- `release()` — transfers the currently releasable tranche to beneficiary, fee to treasury.
- `submitEvidence(bytes32 bundleHash)` — beneficiary; opens voting window.
- `vote(bool approve)` — weight = `donated[msg.sender]`; one vote per donor per round.
- `closeVote()` — anyone after window; computes pass / reject / needs-review.
- `claimRefund()` / `settleToPool(address donor)` — for FAILED or REJECTED remainder, pro-rata.
- `sweepUnclaimed()` — after sweep delay → general pool.

Events: `Donated`, `PreferenceSet`, `Finalized`, `PayoutModeSet`, `TrancheReleased`, `EvidenceSubmitted`, `Voted`, `VoteClosed`, `Refunded`, `SentToPool`, `Frozen`, `Resolved`.

Full function and event list: docs/technical/02-smart-contracts.md §3, §5.

**Invariant**: `USDC.balanceOf(campaign) == totalRaised − released − fees − refunded − sentToPool` at all times.

### 2.4 Tokens
- USDC Polygon mainnet: `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` (native Circle USDC, 6 dec). **Not** USDC.e.
- USDC Amoy: `0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582` (Circle testnet; faucet.circle.com). Local tests use a `MockUSDC`.
- CHR (Phase 2): Polygon child `0xfcfE798Dfb904f096c8e010F1254710E17AF1F81`.

## 3. Wallets, auth and donations

- **Privy**: email / Google / Apple login → embedded EOA signer → **ERC-4337 smart account** (Privy smart wallets with Alchemy bundler + Gas Manager policy restricted to our contracts and USDC `approve`).
- **External wallets**: connect through **Privy** as well (Privy performs SIWE; ADR-024); they pay their own (tiny) POL gas.
- Session: own signed, httpOnly app session cookie (7 days) holding `userId` and roles; roles and account existence are re-read from the DB on every admin action (ADR-024, ADR-028). One user may link several addresses; donations are attributed by address → user via `user_addresses`.
- **Card flow (ADR-051 replaces the Transak-only flow below):** donor logs in → "Add money" (minimum 20 €) → Privy `useAddFunds` with destination = the user's smart account, USDC on Polygon (Stripe / Coinbase Onramp; Transak as fallback) → USDC arrives → the donor donates as usual (one sponsored batch). No onramp webhooks are needed for this: the donation reads the wallet balance. *Original plan:* donor logs in → Transak widget with `walletAddress = user's smart account`, `cryptoCurrencyCode=USDC`, `network=polygon` → Transak webhook marks order complete → UI prompts one-click sponsored `donate` (batched approve+donate). If the user leaves, the USDC stays in their wallet and a "Finish your donation" reminder is shown/emailed.
- Admin access: platform admins are allow-listed user IDs; every admin page and API requires a second factor — our own TOTP (authenticator app), proved at most 12 hours ago (ADR-056, replaces "fresh Privy MFA").

## 4. Backend

### 4.1 `apps/web`
- App Router, `[locale]` segment, next-intl.
- Route handlers `/api/v1/*` (public read API: campaigns, orgs, trust scores, pools; OpenAPI at `/api/v1/openapi.json`, Swagger UI at `/docs/api`).
- Authenticated handlers for drafts, uploads (presigned URLs to private storage), ratings, KYB, admin.
- `public/llms.txt`, JSON-LD on campaign/org pages, sitemap.

### 4.2 `apps/indexer` (Ponder)
Indexes `CampaignFactory`, all `Campaign` clones (factory pattern), `EmergencyPool`. Writes its tables to a per-deploy schema `chain_<sha7>` and publishes stable read views in schema `chain`; its RPC cache lives in `ponder_sync` (ADR-026). Old schemas are pruned by our own script, which keeps the live one and one previous (ADR-029). App tables reference chain data by address and read only the `chain` views. Web app never writes chain state.

### 4.3 `apps/worker` (BullMQ queues)
| Queue | Job |
|---|---|
| `registry-import` | Download & upsert SI / UK / US registries (monthly) |
| `trust-score` | Recompute org score on events + nightly |
| `points` | Award PoC points from indexed events & signed actions |
| `kyc` | Process Sumsub webhooks |
| `onramp` | Process Transak webhooks |
| `notify` | Emails (vote opened, refund available, finish donation) |
| `evidence` | Hash bundles, virus scan, thumbnailing |
| `levels` | Monthly status reset / demotion |

### 4.4 Data model (Drizzle, schema `app`) — outline
`users`, `user_addresses`, `user_roles`, `organizations` (source: `REGISTERED|IMPORTED`, registry ids, kyb_status, claimed_by), `org_members`, `kyb_submissions`, `kyc_checks` (Sumsub applicant id + status only — no documents), `campaigns` (draft data, EUR target, rate snapshot, onchain address), `campaign_media`, `evidence_bundles` (hash, storage keys, status), `ratings`, `points_ledger`, `user_levels`, `trust_scores` (org_id, version, score, components jsonb, computed_at), `registry_records` (raw import), `emergency_subpools` (metadata), `audit_log`, `onramp_orders`.

### 4.5 Files
- **Public** (campaign images, redacted public evidence): upload → PollinationX (Pinata fallback) → CID stored.
- **Private** (KYB docs, invoices, medical docs): see **ADR-033**, which supersedes the earlier "presigned upload with SSE" design. Files pass through authenticated route handlers of the web app, are encrypted by the app (AES-256-GCM, key per environment) and stored in a private Hetzner Object Storage bucket per environment; no presigned URLs; every admin download is audited. Retention: ADR-034. Access for donors to evidence of their campaign is decided with the evidence task. SHA-256 of evidence bundle manifest anchored on-chain. Deletion workflow for GDPR.

## 5. Infrastructure

- **Server**: Hetzner **CX33** (4 vCPU shared, 8 GB RAM, 80 GB SSD), **Ubuntu 26.04**, IP `49.13.63.71`, SSH key auth only. Upgrade path: rescale to CX43 (16 GB) when memory > 80% sustained; later prod on its own VPS (only the Kamal host changes).
- **Two layers on the host:**
  1. **Shared infra** — `docker compose` project in `/opt/cherrio/infra` (versioned in repo `infra/`): **one** Postgres 16 + pgvector instance with databases `cherrio_dev`, `cherrio_uat`, `cherrio_prod` (separate roles, dev/uat with connection limits and `statement_timeout`), PgBouncer, monitoring (Prometheus, node-exporter, cAdvisor, Grafana, Loki, Promtail), backup timer.
  2. **Apps** — **Kamal 2** destinations `dev`, `uat`, `prod`: services `web`, `indexer`, `worker` (+ `mcp` prod only); one small Redis accessory per env. One kamal-proxy terminates TLS (Let's Encrypt) and routes by hostname.
- **Images are always built in GitHub Actions** and pulled from GHCR — never built on the server.
- **No database/Redis/Grafana port is published on the host.** Only kamal-proxy publishes 80/443. Grafana is reached via SSH tunnel. (Docker bypasses UFW for published ports, so this rule matters.)
- **Firewall**: Hetzner Cloud Firewall (allow 22, 80, 443 inbound) + UFW on host + fail2ban.

#### Memory budget (8 GB + 4 GB swap)
| Component | Budget |
|---|---|
| Postgres (shared, `shared_buffers` 1 GB) | 1.5 GB |
| web ×3 (dev/uat capped 384 MB, prod 768 MB) | 1.5 GB |
| indexer ×3 (256–384 MB) | 1.0 GB |
| worker ×3 (dev/uat 192 MB, prod 384 MB) | 0.8 GB |
| mcp (prod) | 0.15 GB |
| Redis ×3 (maxmemory 64/64/256 MB) | 0.4 GB |
| kamal-proxy + PgBouncer | 0.1 GB |
| Monitoring stack | 0.9 GB |
| OS + Docker | 0.6 GB |
| **Total** | **≈ 6.95 GB** |
Every container has a memory limit. Loki retention 7 days, Prometheus 15 days, Kamal keeps last 3 images per service, weekly `docker image prune`.

### 5.1 Environments

| Env | Git branch | Domains | Chain | Contracts | Data |
|---|---|---|---|---|---|
| **dev** | `dev` | `dev.cherr.io`, `api.dev.cherr.io` | Polygon Amoy | own Amoy deployment | seed data, reset allowed |
| **uat** | `uat` | `uat.cherr.io`, `api.uat.cherr.io` | Polygon Amoy | own Amoy deployment (separate from dev) | seed + test data, **never prod personal data** |
| **prod** | `main` | `app.cherr.io`, `api.cherr.io` (root `cherr.io` = marketing site, ADR-042) | Polygon mainnet | mainnet deployment | real |

- Each env has its **own** database + role (in the shared Postgres), Redis container, indexer, worker, secrets, Privy app, Sumsub level (sandbox for dev/uat), Transak env (staging for dev/uat), Alchemy app, storage bucket.
- Kamal **destinations**: `config/deploy.yml` (shared) + `config/deploy.dev.yml`, `deploy.uat.yml`, `deploy.prod.yml`; secrets in `.kamal/secrets.dev|uat|prod` resolved from GitHub Environment secrets. Service names are suffixed per env (`cherrio-web-dev`, …) so all three coexist on one host.
- dev/uat are protected with basic auth at kamal-proxy level (or Privy allow-list) and `noindex`.
- **Contracts are never deployed by CI.** David deploys per env with the Foundry scripts; addresses go to `packages/contracts/deployments/{amoy-dev,amoy-uat,polygon}.json`.

### 5.2 Git workflow

```
feat/TASK-xxx-*  ─PR─▶  dev  ─PR─▶  uat  ─PR─▶  main (prod)
fix/*            ─PR─▶  dev
hotfix/*  (from main) ─PR─▶ main, then back-merge main → uat → dev
```
- Default branch: `dev`. Branch names: `feat/TASK-001-monorepo-scaffold`, `fix/<short>`, `hotfix/<short>`.
- Branch protection on `dev`, `uat`, `main`: PR required, CI green required, no direct pushes, no force-push, linear history off (merge commits keep promotion traceable).
- A `promotion-guard` CI check enforces: PRs into `uat` only from `dev`; PRs into `main` only from `uat` or `hotfix/*`.
- Release tags on `main`: `vYYYY.MM.DD-N`, generated on prod deploy.

### 5.3 CI/CD (GitHub Actions)

| Workflow | Trigger | Does |
|---|---|---|
| `ci.yml` | PR into `dev`/`uat`/`main`; push to any branch | install, lint, typecheck, unit tests, `forge test`, build |
| `promotion-guard.yml` | PR into `uat`/`main` | fails if source branch not allowed |
| `deploy.yml` | push to `dev` → env `dev`; `uat` → `uat`; **prod: manual** `workflow_dispatch` from `main` until launch (ADR-027) | build images tagged with commit SHA → push to GHCR → `kamal deploy -d <env>` → run DB migrations with `kamal app exec`, **after** the new container takes traffic (safe only because migrations must be backward compatible, see below) → smoke test `/api/health` → on prod create release tag. The indexer is a separate job in the same workflow (ADR-026) |

- Uses **GitHub Environments** `dev`, `uat`, `prod` holding that env's secrets (SSH key for Kamal, registry token, app secrets). Prod environment: deployment restricted to `main`; add required reviewer if the GitHub plan allows it.
- `workflow_dispatch` on `deploy.yml` allows manual redeploy / rollback (`kamal rollback -d <env> <version>`).
- Concurrency group per env so two deploys to the same env never overlap.
- DB migrations must be backward compatible (expand → migrate → contract) so zero-downtime deploys are safe.
### 5.4 Operations
- **Backups**: off-site `pg_dump` runs since TASK-024: `cherrio_prod` daily, `cherrio_uat` weekly (Sunday), `cherrio_dev` none → encrypted with age (private key only in the password manager) → Hetzner Storage Box (ADR-032). **Restore drill** monthly (first Sunday) into a scratch database per `infra/backups/RESTORE-DRILL.md`; before mainnet a drill with real tables (TASK-023).
- **Secrets**: Kamal secrets from 1Password/Bitwarden CLI; no private keys on the server in Phase 1 (operator transactions signed via Safe). Phase 2 signer key → cloud KMS (AWS KMS or Turnkey).
- **RPC**: Alchemy free tier for Amoy; re-evaluate for mainnet indexing load.

## 6. Security

- External smart-contract audit before mainnet (budget line required).
- Foundry unit, fuzz and invariant tests run in CI (`forge test`). Slither has been run manually (TASK-004); Slither in CI is **Planned** (TASK-023).
- Bug bounty after mainnet.
- Transfer ownership of the Ethereum CHR root contract from EOA `0x5a05…2864` to a Safe (after confirming transfers are enabled and not paused). Move team CHR to hardware-secured Safe.
- Rate limiting on API (per IP & per user), CSP headers, Sumsub/Transak webhook signature verification.

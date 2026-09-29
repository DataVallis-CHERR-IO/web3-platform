# CHERR.IO — Technical Architecture (v2)

## 1. System overview

```
             ┌──────────── Browser ────────────┐
             │ Next.js UI · Privy · RainbowKit │
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
| `PlatformConfig` | singleton | Roles, USDC address, fee bps (100 = 1%), success threshold bps (1000), vote window, quorum bps (5000), approval bps (5100), treasury address, refund-sweep delay (180 days) |
| `CampaignFactory` | singleton | Deploys `Campaign` via EIP-1167 clones on admin approval; registry of campaigns |
| `Campaign` | clone per campaign | Escrow, donations, end/finalize, payout (SINGLE/MILESTONES), voting, refunds, freeze |
| `EmergencyPool` | singleton | Sub-pool accounting (`poolId → balance`), direct donations, allocation proposals + votes |
| `TimelockController` | OZ | Admin actions delayed 48h |

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
```
LIVE → SUCCEEDED | FAILED
SUCCEEDED → PAYING (SINGLE) → COMPLETED
SUCCEEDED → MILESTONE_1_RELEASED → VOTING_1 → MILESTONE_2_RELEASED → VOTING_2 → COMPLETED
VOTING_n → NEEDS_REVIEW (no quorum) → resolved by Guardian
VOTING_n → REJECTED (remaining → donors' preference)
any pre-COMPLETED → FROZEN (Guardian) → resolved by Guardian
```

Key functions (indicative; exact signatures defined in tasks):
- `donate(uint256 amount, Preference pref, uint32 subPoolId)` — clips to remaining; records `donated[donor]`, `totalRaised`.
- `setPreference(Preference, uint32 subPoolId)` — until end.
- `finalize()` — callable by anyone after deadline or when full; sets SUCCEEDED/FAILED.
- `setPayoutMode(Mode)` — OPERATOR, only in SUCCEEDED before first release (based on off-chain rating).
- `release()` — transfers the currently releasable tranche to beneficiary, fee to treasury.
- `submitEvidence(bytes32 bundleHash)` — beneficiary; opens voting window.
- `vote(bool approve)` — weight = `donated[msg.sender]`; one vote per donor per round.
- `closeVote()` — anyone after window; computes pass / reject / needs-review.
- `claimRefund()` / `settleToPool(address donor)` — for FAILED or REJECTED remainder, pro-rata.
- `sweepUnclaimed()` — after sweep delay → general pool.

Events: `Donated`, `PreferenceSet`, `Finalized`, `PayoutModeSet`, `TrancheReleased`, `EvidenceSubmitted`, `Voted`, `VoteClosed`, `Refunded`, `SentToPool`, `Frozen`, `Resolved`.

**Invariant**: `USDC.balanceOf(campaign) == totalRaised − released − fees − refunded − sentToPool` at all times.

### 2.4 Tokens
- USDC Polygon mainnet: `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` (native Circle USDC, 6 dec). **Not** USDC.e.
- USDC Amoy: `0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582` (Circle testnet; faucet.circle.com). Local tests use a `MockUSDC`.
- CHR (Phase 2): Polygon child `0xfcfE798Dfb904f096c8e010F1254710E17AF1F81`.

## 3. Wallets, auth and donations

- **Privy**: email / Google / Apple login → embedded EOA signer → **ERC-4337 smart account** (Privy smart wallets with Alchemy bundler + Gas Manager policy restricted to our contracts and USDC `approve`).
- **External wallets**: RainbowKit + **SIWE**; they pay their own (tiny) POL gas.
- Session: Auth.js session holding `userId`, linked addresses, roles. One user may link several addresses; donations are attributed by address → user via `user_addresses`.
- **Card flow**: donor logs in → Transak widget with `walletAddress = user's smart account`, `cryptoCurrencyCode=USDC`, `network=polygon` → Transak webhook marks order complete → UI prompts one-click sponsored `donate` (batched approve+donate). If the user leaves, the USDC stays in their wallet and a "Finish your donation" reminder is shown/emailed.
- Admin access: platform admins are allow-listed user IDs; admin actions require a fresh Privy MFA.

## 4. Backend

### 4.1 `apps/web`
- App Router, `[locale]` segment, next-intl.
- Route handlers `/api/v1/*` (public read API: campaigns, orgs, trust scores, pools; OpenAPI at `/api/v1/openapi.json`, Swagger UI at `/docs/api`).
- Authenticated handlers for drafts, uploads (presigned URLs to private storage), ratings, KYB, admin.
- `public/llms.txt`, JSON-LD on campaign/org pages, sitemap.

### 4.2 `apps/indexer` (Ponder)
Indexes `CampaignFactory`, all `Campaign` clones (factory pattern), `EmergencyPool`. Writes to schema `chain` in Postgres. App tables reference chain tables by address. Web app never writes chain state.

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
- **Private** (KYB docs, invoices, medical docs): presigned upload to Hetzner Object Storage bucket with SSE; access via short-lived presigned URLs, only for admins and (for evidence) for donors of that campaign after login. SHA-256 of evidence bundle manifest anchored on-chain. Deletion workflow for GDPR.

## 5. Infrastructure

- **Hetzner** VPS (start: CCX23 or CPX41), Ubuntu LTS, Docker.
- **Kamal 2**: services `web`, `indexer`, `worker`, `mcp`; accessories `postgres` (+pgvector), `pgbouncer`, `redis`, `prometheus`, `grafana`, `loki`, `promtail`. kamal-proxy terminates TLS (Let's Encrypt) for `cherr.io`, `app.cherr.io`, `api.cherr.io`.
- **CI (GitHub Actions)**: lint, typecheck, unit tests, Foundry tests + coverage, build images. Deploy via Kamal is triggered manually by David.
- **Backups**: nightly `pg_dump` → encrypted (age) → Hetzner Storage Box / separate bucket; **monthly restore drill** documented.
- **Secrets**: Kamal secrets from 1Password/Bitwarden CLI; no private keys on the server in Phase 1 (operator transactions signed via Safe). Phase 2 signer key → cloud KMS (AWS KMS or Turnkey).
- **RPC**: Alchemy free tier for Amoy; re-evaluate for mainnet indexing load.

## 6. Security

- External smart-contract audit before mainnet (budget line required).
- Slither + Foundry invariant tests in CI.
- Bug bounty after mainnet.
- Transfer ownership of the Ethereum CHR root contract from EOA `0x5a05…2864` to a Safe (after confirming transfers are enabled and not paused). Move team CHR to hardware-secured Safe.
- Rate limiting on API (per IP & per user), CSP headers, Sumsub/Transak webhook signature verification.

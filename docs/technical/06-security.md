# 06 — Security

This document summarises the CHERR.IO threat model and the controls that exist in the repository today, from smart contracts to the server, the database, the web app, the CI/CD pipeline and the AI agents that write code. The platform holds donor funds in non-upgradeable escrow contracts whose admin actions are delayed by a timelock and whose emergency freeze sits with a guardian. Off-chain, a single Hetzner VPS hosts all three environments, so isolation between dev/uat and prod relies on per-role database limits, network rules (only 80/443 public) and strict secret handling. Each control is marked **Live on dev**, **Built** or **Planned**; the closing section lists what must be done before mainnet.

Last updated: 2026-10-03

Status legend: **Live on dev** = running on the server for dev · **Built** = in the repo, not yet running/applied on the server or not yet used in prod · **Planned** = in specs/ADRs only.

---

## 1. Threat model summary

| Asset | Main threats | Primary controls (sections) |
|---|---|---|
| Donor funds in escrow (USDC) | Contract bugs, admin key compromise, malicious upgrade, reentrancy | §2 non-upgradeable contracts, timelock, guardian, tests; §3 key custody; external audit before mainnet |
| Admin / operator / guardian keys | Theft, leakage into repo/chat/logs, misuse by automation | §3 Safe on mainnet, testnet-only EOA; §4 secrets never in repo; §10 agents never handle keys |
| Production database (`cherrio_prod`) | Cross-env access from dev/uat, connection starvation, runaway queries, exposure to the internet | §6 per-role isolation, connection limits, timeouts, PgBouncer, no published DB ports |
| Server | SSH brute force, lockout, accidental port exposure through Docker | §5 hardening, UFW + Hetzner firewall, fail2ban, sshd limits |
| User accounts and sessions | Session theft, CSRF, privilege escalation, login abuse | §7 Privy + signed httpOnly cookie, origin check, rate limit, roles from DB |
| Personal data (GDPR) | Personal data on immutable chain/IPFS, inability to erase | §8 no personal data on-chain, erasure flow, private storage |
| Supply chain / deploys | Tampered images, unreviewed prod deploys, MITM on SSH | §9 images built only in CI, manual prod deploy, pinned SSH host keys, branch promotion guard |

Sources: `docs/02-ARCHITECTURE.md` §2, §5, §6; `docs/00-MANIFEST.md` §3, §6; `docs/03-DECISIONS.md` (ADR-009, ADR-014, ADR-021, ADR-024, ADR-025).

---

## 2. Smart-contract controls

| Control | Detail | Status |
|---|---|---|
| Non-upgradeable contracts | No proxies. A new version is a new `CampaignFactory`; existing campaigns finish on their original code (ADR-009). Campaigns are EIP-1167 clones. | Built; deployed on amoy-dev |
| Role-based access | OpenZeppelin `AccessControl` in `PlatformConfig`; no `onlyOwner` shortcuts. `DEFAULT_ADMIN_ROLE` = TimelockController; `OPERATOR_ROLE` = backend relayer (Phase 1 may be the Safe); `GUARDIAN_ROLE` = Safe directly. | Built |
| Timelock on admin actions | Mainnet: TimelockController with a **hard-coded 48 h** delay; `DeployPolygon.s.sol` reverts if `TIMELOCK_DELAY` is set (`TimelockDelayOverrideNotAllowed`) and if the Safe address is not a contract (`SafeMustBeContract`). Testnet: 5 min delay (ADR-025). | Mainnet: Built · Amoy: Live (amoy-dev) |
| Guardian | `freeze` and `resolve` (FROZEN / NEEDS_REVIEW campaigns) are exempt from the timelock so an incident can be stopped immediately. | Built |
| Safe coding patterns | Solidity ^0.8.24, OZ v5, `SafeERC20`, `ReentrancyGuard`, checks-effects-interactions, pull payments; every state change emits an event. | Built |
| Escrow invariant | `USDC.balanceOf(campaign) == totalRaised − released − fees − refunded − sentToPool`, enforced by Foundry invariant tests. | Built |
| Tests | Unit + fuzz (all amount math) + invariant tests; latest reported run 241 Foundry tests passing, ≥ 95–100 % line coverage on `src/` across contract tasks. CI runs `forge fmt --check`, `forge build`, `forge test`. | Built (CI) |
| Static analysis | Slither in CI is in the architecture; it is **not** in `ci.yml` today (TASK-023). | Planned |
| External audit, bug bounty | Audit before mainnet; bug bounty after mainnet. | Planned |
| Deployment hygiene | Contracts are never deployed by CI. Deploy JSON is written only on real broadcast; Foundry `cache/` and `broadcast/` must never be committed (cache holds sensitive values). | Live (process) |

Sources: `docs/02-ARCHITECTURE.md` §2.1–2.3, §6; ADR-009, ADR-025; `docs/tasks/DEPLOY-AMOY.feedback.md`; `docs/tasks/TASK-002.feedback.md`, `TASK-003.feedback.md`, `TASK-004.feedback.md`; `.github/workflows/ci.yml`; `docs/CHEATSHEET.md` §7.2.

---

## 3. Key custody

| Context | Holder | Notes | Status |
|---|---|---|---|
| Testnet (Amoy) admin / guardian / operator / treasury / timelock proposer+executor | One **testnet-only EOA** (`0x4326…B5a7`) | No real funds, no Safe (ADR-025). Must never be used on mainnet. Its private key is entered only in a local terminal with `read -s`, with shell history disabled, and the terminal is closed after the deploy. | Live (amoy-dev) |
| Mainnet admin (via timelock) and guardian | **Safe** | 1 owner (David) with 2 keys he controls (hardware + backup), threshold 1-of-2; more signers can be added later without moving funds (ADR-017). | Planned |
| Mainnet operator (backend relayer) | Phase 1: transactions signed via Safe, **no private keys on the server**; Phase 2: signer key in a cloud KMS (AWS KMS or Turnkey) | | Planned |
| CHR token contracts | Transfer ownership of the Ethereum CHR root contract from an EOA to a Safe; move team CHR to a hardware-secured Safe | | Planned |
| Private files key (`PRIVATE_FILES_KEY`, AES-256, one per environment) | Password manager (`CHERR.IO – private files key <env>`) and the GitHub Environment secret; the web container receives it as an env variable. **If it is lost, every stored file of that environment is unreadable.** No rotation procedure yet (`key_version` column is prepared) | GitHub Environment `dev` secret (set by David); reaches the dev web container with the first deploy that carries TASK-008a-2. The deploy check (`files:check`) fails the deploy if the key no longer decrypts the canary object | Built |
| Backup encryption key (age) | Private key only on David's Mac (password manager + offline copy), **never on the server**; server holds only the public key | | Live |

Sources: ADR-017, ADR-025 in `docs/03-DECISIONS.md`; `docs/02-ARCHITECTURE.md` §2.2, §5.4, §6; `docs/CHEATSHEET.md` §5, §7, §7.2; `infra/backups/RESTORE-DRILL.md`.

---

## 4. Secrets handling

Principles: no secrets in the repo (only `.env.example` files with placeholders), never in chat, never in logs; documentation says **where** a secret lives, never its value.

| Where | What | Status |
|---|---|---|
| David's password manager (macOS Passwords; entries named `CHERR.IO – …`) | DB passwords, Grafana admin, Storage Box, age private key, Alchemy and Etherscan keys, GHCR pull token | Live |
| Server file `/opt/cherrio/secrets/infra.env` | Shared-infra secrets (Postgres superuser and per-env role passwords, PgBouncer admin, indexer role passwords, Grafana admin, age public key, rclone remote). Directory mode 700, file mode **600**; read only with `sudo` in the operator's own terminal. | Live on dev |
| Generated PgBouncer `userlist.txt` | Plain-text role passwords copied from `infra.env` (required for PgBouncer to open server connections); mode **600**, owned by uid 70 | Live on dev |
| GitHub repository secrets | `SSH_PRIVATE_KEY` (CI-only deploy key), `SSH_KNOWN_HOSTS`, `KAMAL_REGISTRY_USERNAME`, `KAMAL_REGISTRY_PASSWORD` (`read:packages`, 1-year expiry) | Live |
| GitHub Environments `dev` / `uat` / `prod` | Per-env app secrets: `DATABASE_URL`, `DATABASE_URL_DIRECT`, `PRIVY_APP_SECRET`, `SESSION_SECRET`, indexer `PONDER_RPC_URL_80002` (and `PONDER_RPC_URL_137` for prod, not created yet), `INDEXER_DATABASE_URL`; vars `APP_ENV`, `HOST`. `prod` is empty until launch and restricted to branch `main`. | dev Live; prod Planned |
| `.kamal/secrets-common` | Variable **names** only, resolved from the CI environment at deploy time | Live |
| App containers | Receive only their own env's secrets; `KAMAL_REGISTRY_PASSWORD` is used only for registry login and never reaches containers. Kamal uploads env files with mode 0600. | Live on dev |

Additional rules:

- Private keys never live in `.env` on the server (Manifest §6).
- Password-bearing scripts avoid argv: the indexer role password reaches `psql` through an environment variable; `ensure-databases.sh --dry-run` masks passwords as `***`.
- `PRIVY_APP_ID` is public and is read at runtime, so one image per commit is valid for any env (ADR-024).
- The RPC URL contains the provider key. The indexer, reconcile and prune filter their own `stdout`/`stderr` and replace the key with `***` (by value, plus a pattern for `/v2/<key>` paths), so it cannot reach container logs or the deploy job log. **Built** in TASK-027, live with the next indexer deploy. The key that appeared in logs before that is not rotated (decision 2026-10-02, David).

Sources: `docs/CHEATSHEET.md` header, §2, §3, §5, §6, §10.1; `docs/00-MANIFEST.md` §3, §6; `config/deploy.yml`; `infra/shared/ensure-databases.sh`; `infra/shared/indexer-role.sql`; `infra/provision/provision.sh`; `docs/tasks/TASK-022.feedback.md`; `docs/tasks/TASK-025-auth.md`.

---

## 5. Server hardening

| Control | Detail | Status |
|---|---|---|
| Non-root operations | User `deploy` (key-only login, `docker` group, passwordless sudo — accepted for Phase 1, to be scoped later) | Live on dev |
| SSH hardening (`infra/provision/harden-ssh.sh`) | Drop-in `00-cherrio-hardening.conf` (sorts before cloud-init's `50-` file): `PermitRootLogin no`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `MaxAuthTries 3`. Pre-flight guards (deploy key present, sudo works), `sshd -t` validation (file removed on failure), reload not restart, `sshd -T` assertion afterwards. | Live on dev |
| SSH availability under scanning (`infra/provision/protect-ssh.sh`) | Drop-in `01-cherrio-capacity.conf`: `LoginGraceTime 20`, `MaxStartups 30:30:120`, `PerSourceMaxStartups 3`. fail2ban: `sshd` jail `mode = aggressive`, `maxretry 3`, `findtime 3600`, `bantime 86400` (24 h); `recidive` jail `findtime 86400`, `maxretry 3`, `bantime 604800` (1 week). Validates and asserts the live config. | Live on dev |
| Firewall | UFW default deny incoming, allow 22/80/443 (provision.sh). Hetzner Cloud Firewall inbound 22/80/443 only, applied before the host OS — needed because Docker bypasses UFW for published ports. | UFW Live; Hetzner firewall confirmation open |
| Patching | `unattended-upgrades` security-only, no auto-reboot | Live on dev |
| Container limits | Every container has a memory limit; Docker log rotation 10 MB × 3 | Live on dev |
| Change control | All server config is code in `infra/`, scripts idempotent with `--dry-run`; no manual server change that is not in the repo; when changing SSH config keep the current session open and verify a new login first; recovery via Hetzner console | Live (process) |

Sources: `infra/provision/provision.sh`, `infra/provision/harden-ssh.sh`, `infra/provision/protect-ssh.sh`, `infra/README.md`, `docs/CHEATSHEET.md` §2, `docs/00-MANIFEST.md` §3, `docs/tasks/TASK-024.feedback.md`.

---

## 6. Database isolation

| Control | Detail | Status |
|---|---|---|
| One role and database per env | `cherrio_dev`, `cherrio_uat`, `cherrio_prod`, each owning its own database; `CONNECT` revoked from `PUBLIC`, so `cherrio_dev` cannot connect to `cherrio_prod` (verified: `permission denied for database "cherrio_prod"`) | Live on dev |
| Connection limits | Web roles 18 each (PgBouncer pool 14 + reserve 2 + 2 direct); indexer roles 10 each; total 90 of `max_connections = 100` | Live on dev (applied with `ensure-databases.sh`, TASK-026) |
| Statement timeouts | `statement_timeout = 30s` on `cherrio_dev` and `cherrio_uat` | Live on dev |
| PgBouncer | Transaction pooling, `auth_type = scram-sha-256`, `admin_users = pgbouncer_admin`, not published on the host | Live on dev |
| Indexer role without app access | `cherrio_indexer_<env>`: may connect to and create schemas in its own DB, owns schema `chain`; **no privilege on schema `app`**; not in PgBouncer's userlist (direct only). Web role may only `SELECT` the `chain.*` views (default privileges), cannot read `chain_<sha7>` or `ponder_sync`, cannot write views. Proven locally (TASK-026). | Live on dev (role in use by the dev indexer; denial checks on the server still to be pasted into the TASK-026 feedback) |
| No public DB ports | Postgres bound to `127.0.0.1:5432`, PgBouncer unpublished; access via SSH tunnel only | Live on dev |
| Operator hygiene | Use `cherrio_*` roles, not `postgres`, for debugging; prod connection in TablePlus marked red with "Safe mode"; never delete or reset `cherrio_prod` | Live (process) |
| Restore safety | `restore.sh` refuses `cherrio_prod` without `--i-know-this-is-prod` | Built |

Sources: `infra/shared/ensure-databases.sh`, `infra/shared/indexer-role.sql`, `infra/shared/compose.yml`, `infra/README.md`, `docs/CHEATSHEET.md` §3, §10.3, `docs/tasks/TASK-024.feedback.md`, `docs/tasks/TASK-026.feedback.md`, ADR-021, ADR-026.

---

## 7. Web application security

| Control | Detail | Status |
|---|---|---|
| Single login system | Privy for email, Google and external wallets (Privy performs SIWE); no RainbowKit, no Auth.js (ADR-024) | Live on dev |
| Session lifetime | Signed httpOnly cookie valid 7 days. A deleted or demoted user loses access immediately, because account existence is checked on every request and roles are re-read from the DB on every admin action (ADR-028) | Live on dev |
| Server session | `POST /api/auth/session` verifies the Privy access token server-side, then issues `cherrio_session`: JWT signed with `jose` HS256 and `SESSION_SECRET`, 7-day expiry, `HttpOnly`, `Secure` (except local), `SameSite=Lax`, `Path=/` | Live on dev |
| Roles from DB | `requireRole('PLATFORM_ADMIN')` re-reads `app.user_roles` on every check; cookie role claims are never trusted. Erased users (no `privy_did`) are treated as logged out. `/en/admin` returns 404 to non-admins. | Live on dev |
| Server-side wallet truth | Wallet linking is reconciled from Privy's server API (`POST /api/auth/wallets/sync`); client-supplied addresses are never trusted; an address owned by another user returns 409 | Live on dev |
| Origin / CSRF check | Mutating routes check `Origin` (or `Referer`) against the env's single origin (`https://dev.cherr.io`, `https://uat.cherr.io`, `https://cherr.io`); 403 otherwise | Live on dev |
| Rate limiting | In-memory sliding window per container on `/api/auth/session`: 20 requests/min per IP (last `X-Forwarded-For` entry set by kamal-proxy). Per-container only. | Live on dev |
| Sanitised health errors | `/api/health` returns only codes (`auth_config_error`, `db_config_error`, `db_unreachable`); details go to the server log, and DB errors log only code + message, never the connection string | Live on dev |
| No secrets in logs | Tokens, cookies and emails are never logged (TASK-025 rule) | Live on dev |
| Audit log | `auth.login`, `auth.logout`, `wallets.synced`, account deletion events with actor and IP | Live on dev |
| Campaign review | Approve/reject only by `PLATFORM_ADMIN` re-read from the DB (404 otherwise); a member of the organisation or the campaign's starter cannot review it; the beneficiary address is copied from the KYB-verified organisation, never typed per campaign; the EUR→USDC rate comes only from the ECB (fixed URL; a test override works only with `APP_ENV=local`), is sanity-checked (format, range, age) and stored with its date — no manual rate; every decision is audited without personal data (TASK-010b, ADR-036) | Live on dev |
| Campaign publishing | The server never holds or uses a key (ADR-035): it prepares the call and only reads the indexer's views. The admin signs with the operator wallet in the browser after checks through the wallet's own provider (chain id, `OPERATOR_ROLE`, the factory's predicted address equals the server's, no campaign for the offchain id yet, no pending earlier transaction). A campaign is linked only if the on-chain row matches address, beneficiary, target and deadline; otherwise it is audited and not linked. On mainnet this becomes a Safe proposal (TASK-023) | Live on dev (TASK-010c) |
| Admin step-up | Fresh Privy MFA for admin actions | Planned (architecture) |
| CSP and security headers | Full CSP, plus API rate limiting per IP & per user | Planned (architecture §6; not in `apps/web` today) |
| Webhook signatures | Sumsub and Transak webhook signature verification | Planned |
| dev/uat access | `noindex` live; basic auth at kamal-proxy or Privy allow-list | Planned |

Sources: ADR-024; `docs/tasks/TASK-025-auth.md`; `docs/tasks/TASK-025.feedback.md`; `apps/web/src/app/api/health/route.ts`; `apps/web/src/lib/security/origin.ts`; `apps/web/src/lib/security/rate-limit.ts`; `apps/web/src/lib/auth/session.ts`; `apps/web/src/middleware.ts`; `docs/02-ARCHITECTURE.md` §3, §5.1, §6; `docs/CHEATSHEET.md` §1.

---

## 8. Privacy and GDPR

| Control | Detail | Status |
|---|---|---|
| No personal data on-chain or on IPFS/PollinationX | Invoices, medical records and IDs go to private storage; only a SHA-256 hash is anchored on-chain (ADR-014) | Rule live; storage Planned |
| Pseudonymous defaults | Default display name `Supporter XXXX`; email stored only if Privy returns one | Live on dev |
| Erasure flow | `DELETE /api/auth/account` → `eraseUser()` in one transaction: anonymise user (name "Deleted user", email and `privy_did` cleared), delete `user_addresses`, `user_roles`, `org_members`, `kyc_checks`, strip IPs from the user's audit entries and signatures from ratings; then delete the Privy user (failure is logged to the audit log). On-chain donations stay public but are no longer linked to the person. Since TASK-008c-3 (**Built**) it also closes the user's pending KYB application and deletes their private files except those of approved applications (see `03-data-and-indexer.md` §2.4). | Live on dev |
| KYC data | Sumsub applicant id + status only; ID documents never stored (Manifest §4) | Planned (TASK-009) |
| Private storage (ADR-033) | Files are encrypted **by the app** before they reach Hetzner Object Storage: AES-256-GCM, random 96-bit IV per file, 16-byte auth tag, object = `[version][IV][ciphertext][tag]`. The object key is authenticated as additional data, so an object copied to another key does not decrypt — and a file's storage key must never change after upload. Decryption failure (wrong key, tampered or moved object) raises an error; unverified bytes are never returned. Only PDF, JPEG and PNG by magic bytes, at most 10 MB; SHA-256 of the plaintext is stored. Object keys and rows contain no file names or personal data. No presigned URLs. | **Built** (TASK-008a-1, 008a-2) |
| Private file access | Upload: logged-in user, origin check, 30/min per user, 2 uploads at a time per container, `Content-Length` required, at most 10 unattached files per user. Download: `PLATFORM_ADMIN` only (role re-read from the DB), 404 for everyone else including the uploader; each download writes `audit_log` (`private_file.download`, actor, file id, document kind, IP) **before** the file is sent. Delete: the row is marked deleted before the object is removed; a failed object delete is left for `files:sweep`. Logs contain no object keys, file names or contents | **Built** (TASK-008a-2) |
| KYB review (ADR-012) | Only `PLATFORM_ADMIN` (role re-read from the DB; 404 for everyone else). **Nobody reviews their own organisation:** a reviewer who submitted the application or is a member of the organisation in any role (`ORG_ADMIN` or `ORG_MEMBER`) is refused in the server logic. **Approval confirms the payout address:** the reviewer must type its last 6 characters and the server compares them, because approval writes the address that later receives payouts. A claim or resubmission changes the public organisation row only on approval; a rejected claim leaves an imported organisation unchanged (`NONE`) and removes the claimant's membership. Each decision is one transaction and is audited (`kyb.approve`, `kyb.reject`, `organization.member_removed`); the reviewer's note is not copied to the log. No second reviewer and no admin MFA yet | **Built** (TASK-008c-1, 008c-2) |
| Public campaign media (ADR-037) | Cover images go through the app, never straight to the bucket: `ORG_ADMIN` of a verified organisation only; JPEG/PNG/WebP by magic bytes; at most 5 MB and 40 megapixels; **always re-encoded on the server** (sharp → WebP), which drops all metadata — EXIF, GPS position, camera and date — after the EXIF orientation has been applied. A test uploads a photo with EXIF and GPS and checks that the stored object has none. Object keys are the campaign id and random bytes, never a file name. The bucket is public by design: a cover is readable by its URL as soon as it is uploaded, also for a draft that is never approved; the form tells the organisation not to use a photo of a person without permission | **Live on dev** (TASK-010a) |
| Public campaign media without review (ADR-039) | Gallery images, video links and PDFs are **not reviewed** before they are public (David, 2026-10-03). Controls: only the `ORG_ADMIN` of the campaign's organisation can add or remove; images go through the cover pipeline (metadata stripped); a PDF must start with `%PDF-` and is at most 20 MB, but is otherwise **stored unchanged** — it can contain metadata, links or scripts. It is served from the bucket's own origin (Hetzner), not from the app's origin, so it cannot read the app's cookies; browsers open it in their PDF viewer. Video links: exact hosts over `https` only and a strict id format, so no other site can be embedded; only the id is stored. Every add, remove and takedown is in `audit_log` with the actor. Limits per campaign (10/3/5) and 30 requests/min per user. A platform admin can take any item down (`campaign.media_takedown`); there is no automatic scanning (Planned, if needed) | **Built** (TASK-030) |
| KYB document retention (ADR-034) | Never-submitted uploads: deleted after 24 h (`files:sweep`). Rejected applications: files deleted when the applicant erases their account, and otherwise 90 days after the review (`kyb_submissions.reviewed_at`, `files:sweep`); the submission row and the reviewer's note stay. Approved applications: files kept while the organisation is on CHERR.IO — deleting them when an organisation is removed is Planned (no removal exists yet). The row is always marked deleted before the object is removed. `files:sweep` is run by hand weekly until the worker schedules it | **Built** (TASK-008a-2, 008c-3) |
| Environment data rules | uat never receives prod personal data; dev is not backed up | Live (rule) |
| Fresh start | No migration of the 2018 platform's users (ADR-015) | Live (rule) |

Sources: ADR-014, ADR-015, ADR-033, ADR-034, ADR-037, ADR-039 in `docs/03-DECISIONS.md`; `docs/00-MANIFEST.md` §6; `docs/02-ARCHITECTURE.md` §4.5; `apps/web/src/lib/files/*.ts`; `packages/db/src/schema/files.ts`; `packages/db/src/gdpr.ts`; `docs/tasks/TASK-025.feedback.md`; `config/deploy.uat.yml`.

---

## 9. CI/CD security

| Control | Detail | Status |
|---|---|---|
| Images built only in CI | Web and indexer images are built in GitHub Actions and pushed to GHCR (`GITHUB_TOKEN`, `packages: write`); the server only pulls with a read-only token; images run as non-root users | Live on dev |
| Immutable tags | Images tagged `sha-<7 chars>`; `/api/health` smoke test checks the deployed SHA | Live on dev |
| Prod deploy manual only | `deploy.yml` triggers on push to `dev` and `uat`; prod only via `workflow_dispatch`; GitHub Environment `prod` restricted to branch `main` (required reviewer if the plan allows) | Built |
| Promotion guard | `promotion-guard.yml`: PRs into `uat` only from `dev`; into `main` only from `uat` or `hotfix/*` | Live |
| Branch protection | PR + green CI required, no direct or force pushes on `dev`, `uat`, `main` (GitHub setting described in the architecture; not verifiable from the repo) | Planned/unverified |
| Pinned SSH host keys | `SSH_KNOWN_HOSTS` secret (from `ssh-keyscan`) is written to `known_hosts` before Kamal connects; Kamal `ssh.keys_only: true` | Live |
| Dedicated deploy key | `SSH_PRIVATE_KEY` is a CI-only key | Live |
| Deploy serialisation | One deploy per branch at a time, never cancelled mid-run | Live |
| Contracts never deployed by CI | Manual Foundry deploys by David | Live (rule) |
| Backward-compatible migrations | Expand → migrate → contract, because migrations run after the new container takes traffic | Live (rule) |

Sources: `.github/workflows/deploy.yml`, `.github/workflows/promotion-guard.yml`, `.github/workflows/ci.yml`, `config/deploy.yml`, `config/indexer.yml`, `Dockerfile`, `Dockerfile.indexer`, `docs/02-ARCHITECTURE.md` §5.2–5.3, ADR-020, `docs/CHEATSHEET.md` §6, `docs/tasks/TASK-022.feedback.md`.

---

## 10. AI-agent controls

The implementer is Claude Code working in the repo; the CTO role (Claude in the project chat) writes specs and reviews. David is the only human with commit, deploy and key authority.

| Control | Detail | Status |
|---|---|---|
| Agents never commit, push, merge, deploy or touch keys/secrets | Manifest §2 and `CLAUDE.md` "Hard rules"; David commits | Live (process) |
| Enforced deny rules | `.claude/settings.json` denies `git commit/push/merge/rebase/reset/stash`, `ssh`, `scp`, `rsync`, `kamal`, `sudo`, `brew`, `npm install -g`, and reading `.env`, `.env.*` (any depth) and `.kamal/secrets*` | Live |
| No broadcasts | `CLAUDE.md` forbids `forge script --broadcast` | Live (process; not in the deny list) |
| Server changes only with approval | Agent writes and dry-runs infra scripts; David applies them. Read-only diagnostics allowed; anything that changes the server requires David's OK with the exact command shown first. | Live (process) |
| No unverified evidence | Outputs not produced in the session must be marked `NOT RUN`; tests must be able to fail (TASK-025 review round 2 was deleted for containing outputs never produced) | Live (process) |
| No machine changes | No `brew`, global installs, `sudo`, DB role creation on the developer machine (an earlier agent's Homebrew Postgres install is an open clean-up item) | Live (process) |

Sources: `docs/00-MANIFEST.md` §2–§3, `CLAUDE.md`, `.claude/settings.json`, `docs/tasks/TASK-025.feedback.md` "Review round 3", `docs/CHEATSHEET.md` §9.

---

## 11. Open security items before mainnet

| Item | Source |
|---|---|
| External smart-contract audit (budget line), Slither in CI, audit preparation and mainnet deployment runbook (TASK-023) | `docs/02-ARCHITECTURE.md` §6, `docs/tasks/README.md` |
| Mainnet ownership through a **Safe** with the hard-coded 48 h timelock; amoy EOA never reused | ADR-009, ADR-017, ADR-025, `docs/CHEATSHEET.md` §7 |
| Transfer Ethereum CHR root contract ownership from EOA to a Safe; team CHR to hardware-secured Safe | `docs/02-ARCHITECTURE.md` §6 |
| Off-site encrypted `pg_dump` confirmed and a **restore drill with real tables** before mainnet | ADR-023, `docs/CHEATSHEET.md` §9, `docs/tasks/README.md` "Carry-overs" |
| **Backup of the private files bucket** (none yet) and a tested procedure for rotating `PRIVATE_FILES_KEY`; no virus scan of uploaded documents (they are only served as attachments to admins) | ADR-033, `docs/tasks/TASK-008a1.feedback.md` |
| Separate **prod Privy app** (allowed origin `https://cherr.io`) | `docs/CHEATSHEET.md` §9 |
| Confirm the **Hetzner Cloud Firewall** is created and applied | `docs/CHEATSHEET.md` §9, `docs/tasks/README.md` |
| Populate GitHub Environment `prod` (empty today) and keep it restricted to `main` | `docs/CHEATSHEET.md` §6 |
| Full CSP, API rate limiting per IP & per user, webhook signature verification, admin MFA step-up | `docs/02-ARCHITECTURE.md` §3, §6, `docs/tasks/TASK-025-auth.md` |
| Scope `deploy` passwordless sudo to specific commands | `docs/tasks/TASK-024.feedback.md` |
| Configure alert delivery for Prometheus rules (and backup failure webhook) | `docs/tasks/TASK-024-server-provisioning.md`, `infra/backups/backup.sh` |
| Operator key for Phase 2 in cloud KMS; no private keys on the server in Phase 1 | `docs/02-ARCHITECTURE.md` §5.4 |
| Bug bounty after mainnet; MiCA legal opinion before any CHR distribution (ADR-019) | `docs/02-ARCHITECTURE.md` §6, `docs/03-DECISIONS.md` |
| Promtail → Grafana Alloy migration (Promtail end-of-life) | `infra/README.md`, `docs/tasks/TASK-024.feedback.md` |

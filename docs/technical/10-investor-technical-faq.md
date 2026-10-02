# CHERR.IO — Technical FAQ for investors, auditors and partners

This FAQ answers the technical questions an investor, auditor or partner is likely to ask. Every answer is based only on what is in the repository on the date below, and each one lists its source files. Three labels are used. **Live on dev** means it runs on the dev environment or on the Polygon Amoy testnet, with no real money. **Built (code, not deployed)** means the code exists with tests but is not running anywhere. **Planned (not built yet)** means it is specified but has no code. Where the repository does not answer a question, the answer says **Not decided yet**. Nothing runs on Polygon mainnet, and CHERR.IO does not handle real money yet.

Last updated: 2026-10-02

---

## A. Money and trust

### 1. Can CHERR.IO take donors' money?

No contract function lets CHERR.IO, or anyone else, send escrowed donations to an address of its choosing. A campaign contract can move USDC to four places only:
- the **beneficiary address** fixed when the campaign was created;
- the **treasury**, which receives only the platform fee (1% today; the code caps it at 5%);
- **back to donors**;
- the **Emergency Pool** contract.

The Emergency Pool has no withdraw function. Its money can only go to live campaigns created by the CHERR.IO factory, and only after a contributor vote or a Guardian decision. Tests check this property ("escrow balance conservation") with invariant tests that run 32,768 random calls.

There are honest caveats about what the admin keys can do:
- After the timelock delay (48 h on mainnet), the admin can change the treasury and Emergency Pool addresses in `PlatformConfig`. Campaigns read the Emergency Pool address at the moment they send money to it, so a change would redirect pool-bound money **from then on**. The change is public on-chain during the delay.
- The operator chooses the beneficiary address when it creates a campaign. Platform process (KYB/KYC and admin review) protects that step, not the contract.
- The fee rate is copied into each campaign when it is created, so later fee changes do not affect running campaigns.

Status: contracts Live on dev (Amoy). No external audit yet (see Q22).

Source: packages/contracts/src/Campaign.sol; packages/contracts/src/EmergencyPool.sol; packages/contracts/src/PlatformConfig.sol; docs/tasks/TASK-002.feedback.md; docs/tasks/TASK-003.feedback.md; docs/01-PRODUCT-SPEC.md §2.6; docs/03-DECISIONS.md (ADR-009)

### 2. Where exactly is the money while a campaign is running?

Each campaign has its own smart contract, a cheap "EIP-1167 clone" of one shared Campaign contract. The donated USDC sits in that contract's address on Polygon until the rules release it. CHERR.IO never holds donations in a company bank account or company wallet. Card donors first receive USDC in **their own** wallet and then donate it from there (see Q16). Anyone can check the balances on Polygonscan.

Status: Live on dev (Amoy). Donation UI Planned (not built yet).

Source: packages/contracts/src/CampaignFactory.sol; packages/contracts/src/Campaign.sol; docs/02-ARCHITECTURE.md §2.1; docs/03-DECISIONS.md (ADR-004, ADR-009)

### 3. What happens if a campaign does not reach its goal?

- The campaign **succeeds** if it raises at least **10% of its target** by the deadline. It then pays out what it raised, minus the 1% fee. It also ends immediately when it reaches 100%. A donation that would overshoot the target is clipped to the amount still missing.
- Below 10% the campaign **fails**. Each donor chose a preference when donating (refund, which is the default, or the Emergency Pool) and can change it while the campaign is live.
- Refunds are pull-based: the donor claims them. Anyone can trigger the move of pool-preference money to the pool.
- After **180 days**, anyone can sweep unclaimed refunds to the general Emergency Pool.
- No fee is taken on failed campaigns.

Status: Live on dev (Amoy) in the contracts. Refund UI Planned (not built yet), TASK-013.

Source: packages/contracts/src/Campaign.sol (`donate`, `finalize`, `claimRefund`, `settleToPool`, `sweepUnclaimed`); packages/contracts/src/PlatformConfig.sol; docs/01-PRODUCT-SPEC.md §2.2–§2.3

### 4. What happens if a campaign is a fraud?

There are three layers:
1. **Before launch.** Organisations pass manual KYB by the Data Vallis team. Individuals pass Sumsub KYC plus admin approval. Every campaign is reviewed by an admin before it goes on-chain. (Planned (not built yet), TASK-008/009/010.)
2. **In the contract.** The Guardian can `freeze` a campaign at once from any non-final state (LIVE, SUCCEEDED, PAYING, VOTING, NEEDS_REVIEW). A frozen campaign pays nothing. The Guardian then resolves it. Rejecting moves the campaign to REJECTED, and everything not yet paid out returns **pro-rata** to donors (refund or Emergency Pool, as each donor chose). Even SINGLE payouts wait **72 hours** after the campaign ends, which gives the Guardian time to freeze.
3. **Milestones.** Higher-risk beneficiaries (organisations rated below 4.0, and all individuals) receive the money in three tranches. Donors must approve the evidence before tranches 2 and 3 are paid.

Money already paid to the beneficiary cannot be pulled back by the contract. The 1% fee paid with tranche 1 is also not returned.

Status: contract mechanics Live on dev (Amoy). Verification flows and admin panel Planned (not built yet).

Source: packages/contracts/src/Campaign.sol (`freeze`, `resolve`, `_reject`, `release`); packages/contracts/src/PlatformConfig.sol (`releaseDelay`); docs/01-PRODUCT-SPEC.md §1, §2.4, §2.6; docs/03-DECISIONS.md (ADR-011, ADR-012); docs/tasks/TASK-003.feedback.md

### 5. Who decides whether a beneficiary gets the money all at once or in milestones?

The business rules are:
- organisation rating ≥ 4.0 → **SINGLE**;
- rating < 4.0 → **MILESTONES**;
- first campaign (no rating yet) → SINGLE "under supervision";
- individuals → always MILESTONES.

The rating lives off-chain. The **operator** role sets the payout mode once, after the campaign succeeds. The contract itself refuses SINGLE for individual beneficiaries.

Status: contract Live on dev (Amoy). Rating system Planned (not built yet), TASK-015.

Source: packages/contracts/src/Campaign.sol (`setPayoutMode`); docs/01-PRODUCT-SPEC.md §2.4; docs/03-DECISIONS.md (ADR-011)

### 6. How does donor voting work, and can it be gamed?

After each paid tranche, the beneficiary puts a SHA-256 hash of its evidence bundle on-chain. The evidence itself is invoices, proofs and a video report, and the files stay in private storage. Donors then vote for **24 hours**:
- A vote's weight is the USDC that donor gave to the campaign.
- Each donor gets one vote per round.
- The vote passes if turnout is **≥ 50%** of the donated amount **and ≥ 51%** of the votes cast approve. The next tranche is then paid in the same transaction.
- If turnout is enough but approval is not, the campaign is REJECTED.
- If turnout is too low, the campaign goes to NEEDS_REVIEW and the Guardian decides.

Weighting by amount makes it expensive to buy votes through self-donation, and new donations cannot arrive during voting because the campaign is no longer live. USDC the Emergency Pool gave to a campaign is excluded from the turnout base. Votes on Emergency Pool allocations use contributions recorded **before** the proposal block, which prevents last-minute vote buying.

Status: Live on dev (Amoy). Voting UI Planned (not built yet), TASK-013.

Source: packages/contracts/src/Campaign.sol (`submitEvidence`, `vote`, `closeVote`); packages/contracts/src/EmergencyPool.sol (`voteAllocation`); docs/03-DECISIONS.md (ADR-008); docs/tasks/TASK-003.feedback.md §4

### 7. What if donors simply don't vote?

The campaign goes to `NEEDS_REVIEW`. The Guardian (platform admin) investigates and then approves, which releases the next tranche, or rejects, which returns the remainder to donors pro-rata. The contract has **no timeout**: a NEEDS_REVIEW or FROZEN campaign waits until the Guardian acts.

Status: Live on dev (Amoy).

Source: packages/contracts/src/Campaign.sol (`closeVote`, `resolve`); docs/01-PRODUCT-SPEC.md §2.4

### 8. What does CHERR.IO earn? What are the fees?

In Phase 1 the platform fee is **1% of the amount raised**, taken at payout and sent to the treasury address. For MILESTONES campaigns the full fee is paid with tranche 1. Failed campaigns pay no fee. The admin can change the fee only through the timelock, up to a hard maximum of 5%, and only for campaigns created after the change.

In Phase 2 the whitepaper's 4% model applies: 1.5% to CHR lockers, 1.5% to activators and 1% to the platform. Until then the extra 3% stays with the beneficiary.

Gas sponsorship for smart-account donors will be a platform cost (Planned (not built yet), TASK-011). Card-onramp fees (Transak) are **Not decided yet** in the repo.

Source: packages/contracts/src/PlatformConfig.sol; packages/contracts/src/Campaign.sol; docs/03-DECISIONS.md (ADR-010); docs/01-PRODUCT-SPEC.md §2.4, §5.4

### 9. Can a donor get their money back from a campaign that succeeded?

Not by choice. Refunds exist only when a campaign **fails** (below 10% at the deadline) or is **rejected** (by donor vote or by the Guardian). The refund preference can be changed while the campaign is live. In a rejected campaign each donor gets a pro-rata share of what had not yet been paid out.

Source: packages/contracts/src/Campaign.sol (`setPreference`, `claimRefund`); docs/01-PRODUCT-SPEC.md §2.2–§2.4

### 10. What is the Emergency Pool and who decides how it is spent?

The Emergency Pool is one contract with a general pool (id 0) and thematic sub-pools created by the operator. Money comes from:
- donors who chose "Emergency Pool" on failed or rejected campaigns;
- unclaimed refunds swept after 180 days;
- direct donations.

To spend it, the operator proposes an amount from one pool to a **live** campaign created by the CHERR.IO factory. That pool's contributors vote for 24 h, with weight equal to what they contributed before the proposal, under the same 50% / 51% rule. If turnout is too low, the Guardian decides. A passed allocation counts as a donation from the pool. If that campaign later fails, anyone can return the money to the pool.

Status: contract Live on dev (Amoy). UI Planned (not built yet), TASK-014.

Source: packages/contracts/src/EmergencyPool.sol; docs/01-PRODUCT-SPEC.md §2.5; docs/tasks/TASK-004.feedback.md

---

## B. Blockchain, keys and control

### 11. What is stored on the blockchain?

On-chain (public and permanent):
- each campaign's beneficiary address, USDC target, deadline, beneficiary type (organisation or individual) and a 32-byte off-chain ID;
- every donation (donor address, amount, refund/pool preference);
- payout mode, every payout and fee;
- the evidence **hash**;
- every vote with its weight;
- Guardian freezes and decisions;
- refunds and Emergency Pool balances, allocations and votes.

**No personal data** goes on-chain or to IPFS/PollinationX: no names, emails, documents or invoices. Those stay in Postgres or encrypted private storage. Donor addresses are pseudonymous, and the link between a person and an address lives only in the database.

Source: packages/contracts/src/Campaign.sol; packages/contracts/src/CampaignFactory.sol; packages/contracts/src/EmergencyPool.sol; docs/03-DECISIONS.md (ADR-014); docs/00-MANIFEST.md §6

### 12. Can the smart contracts be changed?

No. The contracts are **non-upgradeable**: no proxy upgrade path exists, and the campaign template disables re-initialisation. A new version means deploying a new factory; old campaigns finish on their old code.

What *can* change is a set of parameters in `PlatformConfig`, and only by the admin role, which is the timelock:

| Parameter | Allowed range |
|---|---|
| fee | 0 – 5% (today 1%) |
| success threshold | 0.01% – 100% (today 10%) |
| vote window | 1 h – 14 days (today 24 h) |
| quorum | 0.01% – 100% (today 50%) |
| approval | 50.01% – 100% (today 51%) |
| refund sweep delay | 30–365 days (today 180 days) |
| minimum donation | > 0 (today 1 USDC) |
| SINGLE release delay | 0 – 7 days (today 72 h) |
| treasury and Emergency Pool addresses | any non-zero address |
| role assignments | grant/revoke any role |

Most of these values are copied into each campaign when it is created, so running campaigns are not affected. The exceptions are the minimum donation and the treasury and Emergency Pool addresses, which campaigns read live.

Source: docs/03-DECISIONS.md (ADR-009); packages/contracts/src/PlatformConfig.sol; packages/contracts/src/Campaign.sol (`initialize`); docs/02-ARCHITECTURE.md §2.1

### 13. Who controls the admin keys today, and who will at mainnet?

| | Today (Amoy testnet, dev) | Mainnet (planned) |
|---|---|---|
| Operator, Guardian, timelock proposer/executor, treasury | **One testnet wallet** (`0x4326…B5a7`) controlled by David | A **Safe** multisig. The mainnet deploy script grants the operator and Guardian roles to the Safe and makes it the timelock's proposer/executor. |
| Admin (`DEFAULT_ADMIN_ROLE`) | TimelockController with a **5-minute** delay | TimelockController with a **48-hour** delay hard-coded in the deploy script. Any override is refused. |
| Safe signers | – (no Safe on testnet) | Currently planned: **1 owner (David) with 2 keys** (hardware + backup), **threshold 1-of-2**, with more signers to be added later. |
| Deployer key | Renounces admin after deployment | Same |

Plainly put: at mainnet launch, one person would still control the Safe unless more signers are added first. The Guardian powers (freeze/resolve) are deliberately **not** delayed by the timelock. Architecture §2.2 also mentions a backend relayer key in a cloud KMS for the operator, while Phase 1 "may be Safe". Which one is used at launch is **Not decided yet** beyond the deploy script.

Source: docs/03-DECISIONS.md (ADR-009, ADR-017, ADR-025); docs/02-ARCHITECTURE.md §2.2, §5.4; packages/contracts/script/DeployPolygon.s.sol; packages/contracts/script/DeployAmoy.s.sol; docs/tasks/DEPLOY-AMOY.feedback.md; docs/CHEATSHEET.md §7

### 14. Could the Guardian abuse its power?

The Guardian can:
- stop payouts (freeze);
- approve or reject a frozen or NEEDS_REVIEW campaign;
- approve or reject a NEEDS_REVIEW pool allocation.

It **cannot** send funds anywhere except to the beneficiary, back to donors, or to the Emergency Pool. Its main power of abuse is therefore **delay or denial**: it can freeze a campaign and leave it frozen (there is no timeout), or reject a legitimate campaign so that money returns to donors. Every Guardian action is a public on-chain event.

Source: packages/contracts/src/Campaign.sol (`freeze`, `resolve`); packages/contracts/src/EmergencyPool.sol (`resolveAllocation`); docs/01-PRODUCT-SPEC.md §2.6

### 15. What happens if the company disappears?

The contracts and all their data stay on Polygon. Many functions need no CHERR.IO involvement and can be called by anyone, for example through Polygonscan:
- donating;
- finalising after the deadline;
- releasing a SINGLE payout or tranche 1, once the payout mode is set;
- the beneficiary submitting evidence;
- donors voting and closing votes;
- claiming refunds;
- moving pool-preference money;
- sweeping after 180 days;
- donating to the Emergency Pool;
- closing pool votes;
- reclaiming pool money from failed campaigns.

Some steps **require the operator or Guardian**: setting the payout mode after success, resolving NEEDS_REVIEW or FROZEN campaigns, proposing pool allocations and creating campaigns. Without those keys, such campaigns and the Emergency Pool's unallocated money would stay locked in the contracts, because no timeout exists. The web app, database and indexer would stop.

A business-continuity plan (for example handing the keys to other signers) is **Not decided yet**.

Source: packages/contracts/src/Campaign.sol; packages/contracts/src/EmergencyPool.sol; packages/contracts/src/CampaignFactory.sol; docs/02-ARCHITECTURE.md §2.2

### 16. How do card donors work?

The card donor logs in with email or Google through Privy, which creates an embedded wallet for them. The Transak widget then sells them USDC on Polygon, **delivered to the donor's own wallet**, and the donor confirms one gas-sponsored `donate` transaction. CHERR.IO never holds the fiat or the USDC. If the donor leaves halfway, the USDC stays in their wallet and they see a "finish your donation" reminder.

Status: Privy login and embedded wallets are Live on dev. The Transak flow is Planned (not built yet), TASK-012. Smart accounts and gas sponsorship are Planned (not built yet), TASK-011.

Source: docs/03-DECISIONS.md (ADR-003, ADR-004, ADR-024); docs/02-ARCHITECTURE.md §3; docs/01-PRODUCT-SPEC.md §2.2; docs/tasks/TASK-025.feedback.md

### 17. Do donors need to understand crypto or pay gas?

They should not have to. Login works with email or Google, and the donor-facing interface shows EUR without Web3 words, with a "proof" layer one click away for anyone who wants on-chain detail. Users with Privy smart accounts get gas sponsored through the Alchemy Gas Manager. External-wallet users (for example MetaMask) pay their own small POL gas.

Status: login and design system Live on dev. Gas sponsorship Planned (not built yet), TASK-011.

Source: docs/03-DECISIONS.md (ADR-003, ADR-022, ADR-024); docs/02-ARCHITECTURE.md §3

### 18. Why USDC on Polygon? What about euros?

USDC gives charities a stable value, and Polygon gives cheap transactions and simple accounting. CHERR.IO uses native Circle USDC, not the bridged USDC.e. Targets are set in EUR and converted to USDC **once, at approval**, with the rate, its source and its timestamp stored. On-chain logic works only in USDC. In the code, money always uses 6-decimal integer math (`bigint`), never floating point.

One risk to note: USDC is issued by Circle, which can blacklist addresses. If a beneficiary address were blacklisted, payouts would revert. The tested recovery path is a Guardian freeze followed by rejection, which refunds donors pro-rata.

Source: docs/03-DECISIONS.md (ADR-002); docs/02-ARCHITECTURE.md §2.4; docs/00-MANIFEST.md §6; docs/tasks/TASK-003.feedback.md §12

### 19. What is the CHR token's role? Is there a token sale?

CHERR.IO keeps its **existing** CHR token, on Ethereum and as a Polygon PoS child token, rather than creating a new one. In Phase 1, CHR is not used at all. CHR activation, locking, rewards and points-to-CHR conversion are Phase 2.

The allocation of team-controlled CHR is only **Proposed** (ADR-007, not accepted). ADR-019 requires a MiCA legal opinion before any CHR distribution. No token sale is specified anywhere in the repo.

Source: docs/03-DECISIONS.md (ADR-006, ADR-007, ADR-019); docs/01-PRODUCT-SPEC.md §5; docs/00-MANIFEST.md §7

---

## C. Data, privacy and verification

### 20. Is it GDPR compliant?

The design follows GDPR principles, and parts of it are built:
- **Personal data never goes on-chain or to IPFS/PollinationX** (ADR-014). Private files will go to encrypted object storage, with only their hash on-chain (Planned (not built yet), TASK-008).
- **Right to erasure:** "Delete my account" on the account page is **Live on dev**. In one database transaction it:
  - clears the email and Privy ID and renames the user to "Deleted user";
  - deletes the link between the person and their wallet addresses, plus roles, org memberships and the KYC reference;
  - strips IP addresses from the audit log and signatures from ratings.

  It then deletes the user at Privy.
- **KYC:** CHERR.IO stores only the Sumsub applicant ID and status, never ID documents.
- **Default display name** is pseudonymous ("Supporter XXXX").

Limits:
- On-chain donations by an address cannot be erased, although they are pseudonymous once the link is deleted.
- Encrypted database backups keep data for up to 56 days.
- The privacy policy and data processing agreements with Sumsub, Transak and Privy are listed as requirements, with no evidence in the repo that they are done.
- No formal GDPR assessment is documented: **Not decided yet**.

Source: docs/03-DECISIONS.md (ADR-014, ADR-015); docs/01-PRODUCT-SPEC.md §7; packages/db/src/gdpr.ts; docs/tasks/TASK-005.feedback.md; docs/tasks/TASK-025.feedback.md; infra/backups/backup.sh

### 21. How are charities and individuals verified?

Organisations go through a **manual KYB review** by the Data Vallis team (ADR-012). Individuals go through **Sumsub KYC** plus admin approval, and in Phase 1 always receive MILESTONES payouts (ADR-011). Community vetting of individual campaigns is Phase 2.

Status: Planned (not built yet), TASK-008 and TASK-009. The database tables for KYB submissions and KYC checks exist.

Source: docs/03-DECISIONS.md (ADR-011, ADR-012); docs/01-PRODUCT-SPEC.md §1, §2.1; docs/tasks/TASK-005.feedback.md

### 22. How is the Charity Market Cap / Trust Score calculated?

The Trust Score runs from 0 to 100 and is a published, versioned formula:

| Component | Weight |
|---|---|
| Community rating (Bayesian average) | 30% |
| Campaign success rate | 25% |
| Milestone approval rate | 20% |
| Evidence completeness | 15% |
| Verification | 10% |

Organisations imported from the Slovenian, UK and US registries that are not on CHERR.IO are capped at 40. Each score stores its formula version.

Status: Planned (not built yet), TASK-016 and TASK-017. The `trust_scores` table exists.

Source: docs/01-PRODUCT-SPEC.md §4; docs/03-DECISIONS.md (ADR-013); docs/tasks/TASK-005.feedback.md

---

## D. Engineering quality

### 23. How is the code tested?

- **Smart contracts (Foundry):**
  - 241 tests passing at the Amoy deployment, made up of unit tests, fuzz tests (1,000 runs each) and invariant suites (32,768 random calls each, 0 reverts) that check escrow balance conservation, exact tranche math and pool balance conservation;
  - 100% line coverage on Campaign, CampaignFactory and PlatformConfig;
  - about 98.5% line coverage on EmergencyPool.
- **Web and database (Vitest):** auth API, session, security and DB-backed tests (36 web tests), 14 database integration tests, and shared money/env tests.
- **End to end (Playwright + axe):** 86 tests, including zero accessibility violations in light and dark themes.
- **Indexer:** unit tests plus a full scenario test on a local chain that reconciles every indexed value against the contracts (0 mismatches), and a deliberate-corruption check that must fail.
- **CI:** GitHub Actions runs lint, typecheck, tests, `forge fmt`/`forge build`/`forge test`, E2E and the indexer scenario on every pull request. Branch protection requires CI to pass.

Feedback files list items that were **NOT RUN**, such as indexer CI on GitHub and anything on the server, so they are not claimed as done.

Source: docs/tasks/TASK-002.feedback.md; docs/tasks/TASK-003.feedback.md; docs/tasks/TASK-004.feedback.md; docs/tasks/DEPLOY-AMOY.feedback.md; docs/tasks/TASK-025.feedback.md; docs/tasks/TASK-006.feedback.md; docs/tasks/TASK-026.feedback.md; .github/workflows/ci.yml; docs/02-ARCHITECTURE.md §5.2

### 24. Has the code been audited?

**Not yet.** An external smart-contract audit is required before mainnet and needs a budget line. Slither (static analysis) was run once by hand in TASK-004 and found 0 high, 4 medium, 14 low and 16 informational issues. The medium findings were explained as false positives or by-design. Adding Slither to CI, audit preparation and the mainnet runbook are TASK-023 (Backlog). A bug bounty is planned after mainnet.

Source: docs/02-ARCHITECTURE.md §6; docs/tasks/TASK-004.feedback.md; docs/tasks/README.md; .github/workflows/ci.yml

### 25. How is the website secured?

- **Login:** Privy is the single login system. The server verifies the Privy token once and issues its own signed, httpOnly session cookie (7 days in the implementation).
- **Admin access:** admin rights are always **re-read from the database**, never trusted from the cookie. The admin page returns 404 to anyone else.
- **Request protection:** a strict per-environment origin check on mutating requests and a rate limit on auth endpoints (20 requests/min per IP, per container).
- **Server:** key-only SSH with root login disabled, firewall open only on 22/80/443, fail2ban. No database, Redis or Grafana ports are published. Secrets are never in the repo.
- **Planned:** admin MFA through Privy is in the spec but Planned (not built yet). API rate limiting, CSP headers and webhook signature checks are Planned (not built yet).

Source: docs/03-DECISIONS.md (ADR-024); docs/tasks/TASK-025.feedback.md; docs/tasks/TASK-024.feedback.md; docs/02-ARCHITECTURE.md §3, §5, §6; docs/00-MANIFEST.md §6

---

## E. Operations

### 26. Where is it hosted?

One **Hetzner Cloud CX33** virtual server (4 vCPU, 8 GB RAM, 80 GB SSD, Ubuntu 26.04) runs all three environments (dev, uat, prod) as separate Docker containers and separate databases on a single shared Postgres instance. Deploys use Kamal 2, and container images are built in GitHub Actions and stored in GitHub's registry. Blockchain access goes through Alchemy, and login through Privy.

The planned upgrade path is a bigger server, and later prod on its own server. The data-centre location is not recorded in the repo: **Not decided yet** (not documented).

Source: docs/02-ARCHITECTURE.md §5; docs/03-DECISIONS.md (ADR-005, ADR-020, ADR-021); docs/CHEATSHEET.md §2, §6

### 27. What does it cost to run?

The repository has **no cost model or EUR figures**: **Not decided yet**. The known cost drivers are:
- the single Hetzner CX33 server, chosen to keep MVP cost low;
- Hetzner backups and a Storage Box;
- the Alchemy free tier for Amoy, to be re-evaluated for mainnet indexing load;
- Privy, Sumsub and Transak accounts;
- gas sponsorship for donors (a platform cost);
- the contract deployment: the full amoy-dev deployment cost 0.27 POL in testnet gas;
- the external audit (a required budget line).

Source: docs/03-DECISIONS.md (ADR-021); docs/02-ARCHITECTURE.md §5.4, §6; docs/CHEATSHEET.md §7, §8

### 28. How are backups and disaster recovery handled?

- **Server snapshots:** Hetzner takes a daily whole-server snapshot with 7-day retention.
- **Off-site database dumps:** an encrypted (age) `pg_dump` goes to a separate Hetzner Storage Box every day at 02:30 UTC. According to the backup script, this covers the **prod** database daily and **uat** on Sundays; the dev database is not dumped. Dumps older than 56 days are deleted.
- **Key handling:** the decryption key is never on the server; restores decrypt on the operator's machine.
- **Restore drill:** one drill was done on 2026-09-29 with an empty database. A drill with real tables is an open item and is required before mainnet (ADR-023).
- **Monitoring:** Prometheus, Grafana and Loki.

Source: docs/03-DECISIONS.md (ADR-023); docs/tasks/TASK-024.feedback.md; infra/backups/backup.sh; docs/CHEATSHEET.md §5; docs/tasks/README.md (Carry-overs)

### 29. What is live today, and what is only code?

- **Live on dev** (https://dev.cherr.io, Amoy testnet, no real money):
  - landing page with sample data;
  - Privy login, account page with account deletion, admin role check;
  - "coming soon" pages;
  - health check;
  - database schema;
  - all contracts deployed and verified on Amoy;
  - the Ponder indexer, which copies every contract event into the database and is checked against the contracts after each deploy.
- **Built (code, not deployed):** the mainnet deploy script.
- **Planned (not built yet):**
  - charity and individual onboarding;
  - campaign creation;
  - donations (wallet and card);
  - payout, evidence and voting UI;
  - Emergency Pool UI;
  - ratings and points;
  - Charity Market Cap;
  - public API, widget and MCP server;
  - admin panel;
  - audit and mainnet.
- **Environments:** uat is not deployed; prod and mainnet are not live.

Source: docs/technical/09-status-and-roadmap.md; docs/tasks/README.md; docs/CHEATSHEET.md §1, §7, §9

### 30. What are the main known technical risks?

1. **Key concentration:** testnet roles sit in one wallet, and the planned mainnet Safe is 1-of-2 with one owner (Q13).
2. **No timeouts:** FROZEN, NEEDS_REVIEW and SUCCEEDED-without-payout-mode states wait indefinitely for the operator or Guardian (Q7, Q15).
3. **USDC blacklisting** of a beneficiary blocks payouts. A Guardian recovery path exists (Q18).
4. **Stray USDC:** tokens sent directly to a completed campaign, outside `donate`, cannot be recovered.
5. **Single server:** dev, uat and prod share one VPS and one Postgres server, mitigated by per-role limits and timeouts (ADR-021).
6. **Indexer:** Polygon reorgs deeper than the hard-coded finality (200 blocks on Polygon, 30 on Amoy) stop the indexer and require a re-index. Its memory use during a backfill has not been measured on the server yet, and it needs a paid RPC plan.
7. **No external audit yet** (Q24).

Source: docs/tasks/TASK-002.feedback.md; docs/tasks/TASK-003.feedback.md §12; docs/tasks/TASK-006.feedback.md; docs/tasks/TASK-026.feedback.md; docs/03-DECISIONS.md (ADR-017, ADR-021, ADR-025); packages/contracts/src/Campaign.sol

### 31. Is the code open source?

The GitHub repository is **private**, and there is no licence file in the repo. Whether and when to open-source the code is **Not decided yet**. The contracts deployed on Amoy are **source-verified on Polygonscan**, so anyone can read their code there. The plan for mainnet is to verify the contracts the same way, as the deploy runbook includes a verification step.

Source: docs/CHEATSHEET.md §6, §7.2; docs/tasks/DEPLOY-AMOY.feedback.md

### 32. Can CHERR.IO migrate the users of the old (2018) platform?

No. The decision is a fresh start: the roughly 30,000 old users are not migrated, and will instead be invited by email later. This keeps data clean and gets fresh GDPR consent.

Source: docs/03-DECISIONS.md (ADR-015)

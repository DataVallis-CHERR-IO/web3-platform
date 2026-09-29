# CHERR.IO — Product Specification (v2)

Canonical business rules. Derived from whitepaper v1.3 (source of truth for economics) and the 2017 token-flow diagram (lifecycle), adapted to USDC on Polygon. Changes go through `03-DECISIONS.md`.

---

## 1. Actors and roles

| Role | Description | Verification |
|---|---|---|
| Visitor | Browses campaigns and Charity Market Cap | – |
| Donor | Logged-in user (Privy or SIWE) who donates | none |
| Cherrion | Any registered user; can earn points, rate, vote | none (Level 1 on registration) |
| Individual beneficiary | Cherrion who starts a campaign for themselves/someone | **Sumsub KYC** + admin approval |
| Organization member / admin | Represents a registered charity | Org passes **manual KYB** |
| Platform admin | Data Vallis staff | allow-listed addresses + 2FA via Privy |
| Guardian | Holds on-chain freeze power | Safe multisig |

---

## 2. Campaign lifecycle

```
DRAFT ──submit──▶ PENDING_REVIEW ──admin approve──▶ [ACTIVATION]* ──▶ LIVE
                        │ reject                                    │
                        ▼                                           ├─ target reached ───────────▶ SUCCEEDED
                     REJECTED                                       ├─ deadline & raised ≥ 10% ──▶ SUCCEEDED
                                                                    └─ deadline & raised < 10% ──▶ FAILED

SUCCEEDED ─▶ PAYOUT (SINGLE → COMPLETED)
          └▶ PAYOUT (MILESTONES → T1 released → vote → T2 → vote → T3 → COMPLETED)
                                              └ vote rejected → REJECTED_PAYOUT (remaining funds → donors' choice)
FAILED ─▶ donors claim refund or funds go to Emergency Pool (per donor preference)
```
\* ACTIVATION (CHR) is Phase 2. In Phase 1, approval moves the campaign straight to LIVE.

### 2.1 Creation
- Fields: title, story (rich text), cause category, country, cover images, **EUR target**, duration (7–90 days), beneficiary payout address, supporting documents (private).
- On admin approval the backend fixes `targetUSDC = targetEUR × EUR/USD rate` (rate snapshot stored with source + timestamp) and deploys the campaign on-chain.
- Organizations can have N parallel live campaigns (Phase 1: admin-set limit, default 5; Phase 2: CHR-deposit tiers).
- Individual campaigns require: completed Sumsub KYC of the starter, supporting documents, admin approval. (Community vetting vote: Phase 2.)

### 2.2 Donations
- Currency: **USDC on Polygon** only. Minimum donation 1 USDC.
- Paths:
  1. **Wallet** (external or embedded) → `approve` + `donate` (batched & gas-sponsored for smart accounts).
  2. **Card** → Transak delivers USDC to the donor's own embedded wallet → donor confirms `donate` (sponsored). Attribution is therefore always the donor's own address.
- A donation that would exceed the remaining target is **clipped** to the remaining amount; the campaign becomes SUCCEEDED immediately.
- At donation the donor sets a **failure preference**: `REFUND` (default) or `EMERGENCY_POOL` (optionally a sub-pool). Changeable until the campaign ends.
- Donations are public on-chain; the UI may show donors as anonymous if they choose (display-only).

### 2.3 End of campaign
- Ends when target reached **or** deadline passes, whichever first.
- **Success** = raised ≥ 10% of target.
- **Failure** = raised < 10% → each donor's amount goes to refund or the Emergency Pool per their preference. Refunds are pull-based (donor claims). Unclaimed refunds after **180 days** can be swept by anyone to the general Emergency Pool.

### 2.4 Payout and fraud protection (whitepaper §End of a Campaign)
- **Platform fee**: 1% of raised amount, taken at payout (Phase 1). Full 4% reward model activates in Phase 2 (see §5).
- **Payout mode** decided at finalization:
  - Organization rating **≥ 4.0** → `SINGLE`: 100% (minus fee) releasable at once.
  - Rating **< 4.0** → `MILESTONES`.
  - **No rating yet** (first campaign) → `SINGLE` under supervision: Guardian may freeze before release (see §2.6).
  - Individual beneficiaries → always `MILESTONES` in Phase 1.
- **Milestones**: net amount split into **3 equal tranches**.
  - T1 released automatically at success.
  - Beneficiary submits evidence for T1 (invoices, transaction proofs, **video report**). Evidence files → private storage; bundle SHA-256 → on-chain.
  - Donors vote for **24 hours** (configurable). **Voting weight = amount donated.**
  - Passes if **turnout ≥ 50%** of total donated weight **and** **≥ 51%** of cast weight approves → T2 released. Same for T2 → T3.
  - **Quorum not reached** → status `NEEDS_REVIEW`; platform admin (Guardian) investigates and resolves approve/reject on-chain.
  - **Rejected** → remaining tranches return to donors pro-rata according to each donor's preference (refund or Emergency Pool).
- After each completed campaign, donors can **rate the organization 1–5** (one rating per donor per campaign, off-chain, signed).

### 2.5 Emergency Pool
- One general pool + thematic **sub-pools** (e.g. medical, disasters, animals, climate). Sub-pools are created by admin.
- Inflows: failed-campaign funds by preference, rejected-milestone funds by preference, swept refunds, direct donations.
- Outflows (**Quick Realisation**): admin proposes allocation of X USDC from pool P to an approved emergency campaign; Cherrions vote (Phase 1: donors-to-that-pool weighted by contributed amount; 24h; same 50% / 51% rule; admin resolves if quorum fails). On pass, funds transfer to the campaign and count as a donation from the pool.

### 2.6 Guardian powers (bounded)
- `freeze(campaign)` — immediate, blocks payouts. Used on suspected fraud.
- `resolve(campaign, approve|reject)` — only in `NEEDS_REVIEW` or `FROZEN` state.
- Guardian **cannot** move funds to arbitrary addresses: funds can only go to the beneficiary, back to donors, or to the Emergency Pool.
- All admin configuration changes go through a **timelock (48h)**; `freeze` is exempt.

---

## 3. Proof of Charity (points)

Phase 1: off-chain ledger, two balances per user (**Status** and **Reward**), no conversion to CHR.

| Action | Points | Phase |
|---|---|---|
| Registration completed | 1,000 (reaches Level 1) | 1 |
| Donation to live campaign | 100 per 1 USDC (provisional, config) | 1 |
| Rate an organization after campaign | 200 | 1 |
| Vote on a milestone | 200 | 1 |
| Verified individual (KYC passed) | 1,000 | 1 |
| Referred organization completes KYB | 3,000 | 1 |
| Social actions (X, Telegram, Reddit, …) | TBD | 2 |
| Lock CHR (new active Cherrion) | 1,000 | 2 |

Dropped from whitepaper: Bitcointalk, Medium follow, "unique click per IP".

**Levels** (Status points): L1 1,000 · L2 3,000 · L3 6,000 · L4 10,000 · L5 15,000.
Monthly reset: Status balance resets to the floor of the current level. No points in a month → demotion by one level (after notification). Reward balance never resets.

Anti-abuse: points only from verifiable events (on-chain donations, signed votes/ratings); per-user daily caps in config; admin can void ledger entries (with reason, audited).

Phase 2: Reward points → CHR at **1,000 points = 1 CHR** via EIP-712 claims signed by a KMS-held backend key, with rate limits and a monthly global cap.

---

## 4. Charity Market Cap

Public, SEO-indexed directory: "CoinMarketCap for charities".

### 4.1 Data sources
- **Registered** orgs (KYB on CHERR.IO) — full data.
- **Imported** from public registries (not on CHERR.IO):
  - Slovenia — Ministry list of NGOs in the public interest + AJPES register
  - UK — Charity Commission register (open data extract)
  - US — IRS Exempt Organizations Business Master File
- Imported orgs show "Not on CHERR.IO" and a **Claim this organization** button (starts KYB).

### 4.2 Trust Score v1 (public, versioned)
Score 0–100 = weighted sum of components, each 0–1:

| Component | Weight | Definition |
|---|---|---|
| Community rating | 30% | Bayesian average: `(C·m + Σr) / (C + n)` with prior m = 3.5, C = 5, then `/5` |
| Campaign success rate | 25% | successful / finished campaigns (prior 0.5 when < 3 finished) |
| Milestone approval rate | 20% | approved votes / decided votes (prior 0.5 when none; 1.0 if all SINGLE payouts delivered evidence) |
| Evidence completeness | 15% | evidence submitted on time / evidence required (prior 0.5) |
| Verification | 10% | KYB on CHERR.IO = 1.0; registry-listed only = 0.5 |

- **Imported (unregistered) orgs**: only Verification + registry data completeness are known → score **capped at 40**.
- Formula version is stored with each computed score; page shows "Trust Score v1" with a link to the methodology page.
- Recomputed by a worker job on relevant events and nightly.

### 4.3 Features (Phase 1)
Listing with sort/filter (score, total raised, country, cause, registered/imported), org profile (history, raised, payouts, votes, ratings, evidence list), methodology page, JSON-LD `Organization` + `AggregateRating`, public API.
Sponsored placements: Phase 2, always labelled.

---

## 5. CHR token and Phase 2 economics

### 5.1 Contracts (existing token — kept, see ADR-006)
| Network | Address | Notes |
|---|---|---|
| Ethereum (root) | `0x385Fe0597Fb60c281b54955e7d15C07578cE745b` | "CHERR.IO" CHR, 18 dec, Solidity 0.4.23, verified. Total supply 85,105,190.56 after 114.89M burn (May 2023). Owner `0x5a05…2864` (EOA). |
| Polygon PoS (child) | `0xfcfE798Dfb904f096c8e010F1254710E17AF1F81` | "CHERR.IO(PoS)", minted only by the Polygon PoS bridge on deposit. Current supply 2,000,000. |

### 5.2 Holdings snapshot (2026-09-29)
- Team wallet `0x5a0548Eae41D0c2f27c1Dc9182577164D9692864`: 76,461,531 CHR (Ethereum)
- Team wallet `0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7`: 2,000,000 CHR (Polygon)
- ~1,940 community holders: ~6.64M CHR (7.8%)

### 5.3 Proposed allocation of the 78.46M team-controlled CHR (ADR-007, proposed)
| Bucket | CHR | % of supply | Terms |
|---|---|---|---|
| Proof of Charity rewards pool | 20,000,000 | 23.5% | Emitted via points conversion, monthly cap, 4+ years |
| Ecosystem & activation grants | 10,000,000 | 11.8% | Seed activation of early campaigns, partner charities |
| Treasury (Data Vallis, Safe) | 18,461,531 | 21.7% | Operations, audits, contingencies |
| Team & advisors | 15,000,000 | 17.6% | 12-month cliff, 36-month linear vesting |
| Strategic partners | 10,000,000 | 11.8% | Case-by-case, vesting |
| Liquidity (Polygon DEX) | 5,000,000 | 5.9% | Only after legal opinion |
| Existing community | 6,643,659 | 7.8% | Untouched |

### 5.4 Phase 2 mechanics (from whitepaper, for later specification)
- **Activation**: campaign raises 1% of target value in CHR; individual activators capped at 5% of activation amount; cap lifts after 7 days (a single "champion" may complete it). Optional for orgs, mandatory for individuals.
- **Activator refund**: by % of target raised — 10%→25%, 20%→30%, 30%→40%, 40%→55%, 50%→75%, ≥60%→100% (+ reward).
- **Reward 4% of raised** (paid in USDC): 1.5% CHR lockers (pro-rata locked amount, locked for entire donation phase), 1.5% activators (pro-rata activation contribution; to the charity if no activators), 1% platform.
- **Locking caps per level**: L1 1,000 · L2 2,000 · L3 3,000 · L4 4,000 · L5 5,000 CHR. Demotion returns excess locked tokens.
- **Org deposit tiers** (locked 3 months): 10,000 CHR → 10 parallel campaigns; 30,000 → 40; 60,000 → 100.
- Requires legal opinion (MiCA) before launch.

---

## 6. Phases

### Phase 1 — MVP (Amoy → Polygon mainnet)
Org onboarding (manual KYB), individual onboarding (Sumsub), campaign creation & admin approval, USDC donations (wallet + card via Transak), payout SINGLE/MILESTONES with donor voting, Emergency Pool + sub-pools, ratings, Proof of Charity ledger (non-convertible), Charity Market Cap v1 with registry imports, admin panel, public REST API + OpenAPI, `llms.txt`, JSON-LD, embeddable donate widget, read-only MCP server, i18n-ready EN UI, monitoring, backups, external audit before mainnet.

### Phase 2
CHR activation, locking, 4% reward distribution, org deposit tiers, points→CHR conversion, social-action points, community vetting of individual campaigns, sponsored listings, pgvector document search.

### Phase 3
ML staking suggestions, NFT badges, white-label, more chains/currencies.

---

## 7. Non-functional
- Languages: EN at launch; all strings via next-intl.
- GDPR: personal data only in Postgres/private storage; deletion workflow; privacy policy; data processing agreements with Sumsub, Transak, Privy.
- Accessibility: WCAG 2.1 AA for core flows.
- Performance: campaign & org pages SSR, LCP < 2.5s.
- Brand: colors and logos from `/brand` assets (Cherrio_Colors.pdf, logos).

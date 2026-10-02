# TASK-010 — Campaign creation, review, EUR→USDC snapshot, on-chain publishing

Branches (David creates them from `dev`, one per PR): `feat/TASK-010a-…`, `feat/TASK-010b-…`, `feat/TASK-010c-…` — the implementer proposes the split in the plan.
Depends on: TASK-006/026 (indexer, `chain` views), TASK-008 (verified organisations, private files, admin review patterns), TASK-007 (design system). Model: strong (money targets, on-chain transaction, admin rights).

## Goal

A verified organisation can prepare a fundraising campaign, a platform admin reviews it, the EUR target is converted to USDC with a stored ECB rate, and the admin publishes the campaign on Polygon from the browser. At the end of this task:

1. An `ORG_ADMIN` of an **APPROVED** organisation creates a campaign draft (title, story, cause, country, EUR target, duration, cover image), edits it and submits it for review.
2. A platform admin approves (with the EUR→USDC snapshot) or rejects it with a note; a rejected campaign can be edited and submitted again.
3. The admin publishes an approved campaign on-chain by signing `CampaignFactory.createCampaign` with their own wallet (must hold `OPERATOR_ROLE`). The server never holds a key.
4. When the indexer has seen `CampaignCreated`, the app links the on-chain address and the campaign becomes `DEPLOYED`.

**Not in this task:** public campaign pages and donations (TASK-011), individual beneficiaries (TASK-009 — organisations only here), evidence and payouts (TASK-013), Safe proposals for mainnet (TASK-023; this task works on Amoy with the testnet operator EOA, ADR-025), IPFS/PollinationX.

## Read first

- `CLAUDE.md`, `docs/00-MANIFEST.md`, `docs/03-DECISIONS.md` (ADR-008…011, ADR-020, ADR-025, ADR-026, ADR-033, and the new ADR-035…038 below)
- `docs/01-PRODUCT-SPEC.md` §2.1 (creation), §2.4 (payout mode is decided later — not here)
- `docs/technical/02-smart-contracts.md` §2 (`CampaignFactory.createCampaign` rules: OPERATOR only, target ≥ 100 USDC, deadline 1–90 days ahead, unique `offchainId`, `beneficiaryType` 0 = ORG)
- `docs/technical/03-data-and-indexer.md` (schema `app.campaigns`, `campaign_media`; `chain` views; web role may read `chain`)
- `packages/db/src/schema/campaigns.ts`, `enums.ts` (`campaign_status`: DRAFT, PENDING_REVIEW, REJECTED, APPROVED, DEPLOYED)
- `apps/indexer/ponder.schema.ts` (campaign table has `offchainId`)
- `packages/shared` (`getChainConfig`, `requireContracts`, `ORGANIZATION_CAUSES`), `packages/contracts/abis`
- TASK-008 code and feedback: `lib/files/*` (storage, magic bytes), `lib/organizations/review.ts` (review pattern, self-review rule, audit), E2E session helper

## Decisions (CTO) — add to `docs/03-DECISIONS.md` in the first PR

Insert after ADR-034. Copy the text as given.

| ID | Date | Status | Decision | Reason |
|---|---|---|---|---|
| ADR-035 | 2026-10-02 | Accepted | **Phase 1 on-chain publishing is signed by the platform operator in the admin's browser.** After approval, an admin publishes the campaign by signing `CampaignFactory.createCampaign` with a wallet that holds `OPERATOR_ROLE` (Amoy: the testnet operator EOA, ADR-025; mainnet: the same action creates a Safe proposal, TASK-023). The server prepares the call data and verifies the result through the indexer; it never holds or uses a private key. Gas is paid by the operator (Data Vallis treasury on mainnet). | Keeps the "no keys on the server" rule; the gas per campaign is cents on Polygon and is covered by the 1 % platform fee. |
| ADR-036 | 2026-10-02 | Accepted | **EUR→USDC target uses the ECB euro reference rate.** At approval the server fetches the latest ECB EUR→USD reference rate (published on working days; the last published rate is used on weekends/holidays), treats 1 USDC = 1 USD, and stores `eur_usd_rate`, `rate_source = "ECB"` and `rate_at` (the ECB rate date). `target_usdc = floor(target_eur_cents × rate × 10^4)` in integer arithmetic (6 decimals). If the rate cannot be fetched, approval is refused (retry later); no manual rate. | Official, free, keyless and verifiable source; the stored snapshot makes every target reproducible. |
| ADR-037 | 2026-10-02 | Accepted | **Public campaign media in a public Hetzner Object Storage bucket per environment** (`cherrio-public-<env>`), served by its public URL. Only non-personal content (cover images). Uploads go through the app: JPEG/PNG/WebP by magic bytes, ≤ 5 MB, re-encoded server-side so that all metadata (EXIF, GPS) is removed. Object keys contain no personal data. IPFS/PollinationX (manifest) is postponed; `campaign_media.storage` gets a new value `HETZNER_PUBLIC`. | Simple and cheap now; metadata stripping prevents leaking locations; the storage column allows a later move to IPFS. |
| ADR-038 | 2026-10-02 | Proposed (direction) | **Phase 2: permissionless campaign publishing.** A `CampaignFactory` v2 lets a verified beneficiary publish its own campaign with its own wallet (and gas), gated on-chain by a registry of verified beneficiaries (set at KYB/KYC approval) and by CHR activation / community vetting (Product Spec §5.4, §6) instead of the Phase 1 operator role and admin approval. Contracts are not upgradeable, so v2 is a new factory; campaigns of v1 finish on v1. | The long-term goal is a self-running ecosystem; Phase 1 keeps admin approval as the fraud filter while the community is small. |

## Setup by David (before the PR that uploads images is proven on dev)

The implementer never sees these values. Write this list into that PR's feedback as "Steps for David".

1. Hetzner Console → Object Storage → bucket `cherrio-public-dev`, **public read** (same location `nbg1`). The existing access key may be reused if it covers both buckets; otherwise create one and add it as secrets as below.
2. `config/deploy.dev.yml` gets `S3_PUBLIC_BUCKET` and `S3_PUBLIC_BASE_URL` as literals (implementer writes them; not secret).
3. The operator wallet (testnet EOA with `OPERATOR_ROLE` on amoy-dev) must have some Amoy POL for gas and must be connectable in the browser (MetaMask via Privy).

## Scope

### Data (backward-compatible migration)

- `campaign_status`: no new values. `APPROVED` + a non-null `publish_tx_hash` means "publishing"; `DEPLOYED` when linked.
- `app.campaigns`: add `submitted_at`, `reviewed_at`, `reviewer_id` (→ users), `publish_tx_hash` (varchar 66, format check), `deadline` (timestamptz, set when the call data is prepared), `deployed_at`. Keep existing columns.
- `storage_provider` enum: add `HETZNER_PUBLIC`.
- `offchain_id`: 32 random bytes, created at approval (not before), unique.
- `beneficiary_address`: copied from the organisation's approved `payout_address` at approval (never typed per campaign).

### Organisation side (ORG_ADMIN of an APPROVED organisation)

- Create / edit draft: title (5–120), story (plain text with paragraphs, 50–10,000 characters; rendered escaped — no HTML, no rich editor), cause (from `ORGANIZATION_CAUSES`), country (ISO alpha-2), EUR target (whole euros, 100–1,000,000), duration 7–90 days (Product Spec §2.1; the contract allows 1–90), one cover image.
- Slug from the title, unique, stable after first submit.
- Submit → `PENDING_REVIEW` (only from DRAFT or REJECTED; edits only in DRAFT/REJECTED).
- Limit: at most **5** campaigns per organisation in PENDING_REVIEW, APPROVED or DEPLOYED (Product Spec §2.1 default; constant in `packages/shared`).
- Pages: list of the organisation's campaigns with status; create/edit form; status/notes view. All text via next-intl; design-system components only.

### Cover image

- `POST /api/campaigns/:id/cover` (ORG_ADMIN, DRAFT/REJECTED only): magic bytes JPEG/PNG/WebP, ≤ 5 MB, re-encode to WebP (max 1600 px wide) server-side, which drops all metadata; store under `campaigns/<campaignId>/<random>.webp` in the public bucket; `campaign_media` row (`COVER`, `HETZNER_PUBLIC`, key in `cid`). Replacing deletes the old object. Justify the image library (e.g. `sharp`) in the plan; it must work in the Docker image (CI image build proves it).
- A test proves EXIF/GPS is gone after upload.

### Admin side (PLATFORM_ADMIN; 404 for everyone else; reviewer may not be a member of the organisation — same rule as KYB)

- Queue of PENDING_REVIEW campaigns, oldest first; detail page with all fields, cover, organisation, payout address (full, checksummed).
- **Approve**: fetch ECB rate (ADR-036), compute `target_usdc`, refuse if `< 100 USDC` (contract minimum), set rate fields, `beneficiary_address`, `offchain_id`, `reviewed_at`, `reviewer_id`, status APPROVED; audit `campaign.approve` (ids, rate, target — no personal data).
- **Reject** with a note (10–1,000) → REJECTED; audit `campaign.reject` (note not copied).
- **Publish on-chain** (APPROVED, not yet published):
  1. Server endpoint prepares the call: factory address from `packages/shared` for `APP_ENV`, `CreateParams { offchainId, beneficiary, target, deadline = now + duration_days, beneficiaryType = 0 }`, and the predicted address (`predictCampaignAddress`). Stores `deadline`.
  2. Browser (wagmi/viem through Privy, external wallet): checks chain id and `hasRole(OPERATOR_ROLE, account)` on `PlatformConfig`; shows a clear error if not; sends the transaction.
  3. Browser posts the tx hash; server stores `publish_tx_hash` (audit `campaign.publish_sent`).
  4. Linking: the server reads the `chain` campaign view by `offchain_id` (web role has SELECT on `chain`). When found and its address equals the predicted one → set `onchain_address`, `deployed_at`, status DEPLOYED, audit `campaign.deployed`. Done on page load of the admin detail page and by a "Check status" action; no RPC key in the web app.
  5. If the tx failed or was never mined, the admin can prepare and send again (new deadline); `offchain_id` stays the same, so a duplicate cannot be created on-chain.

### Tests (must be able to fail)

- Unit: EUR→USDC math (bigint; rounding down; examples incl. a rate with 8 decimals), duration/target validation, slug.
- ECB client: parse the real response format from a fixture; network failure → approval refused. No live network in tests.
- Integration: draft → submit → approve → prepare → (simulate indexer row in `chain` test view/table) → DEPLOYED; reject → edit → resubmit; 6th active campaign refused; non-ORG_ADMIN and non-APPROVED org refused; admin member of the org refused; non-admin 404.
- Image: upload with EXIF GPS → stored object has no EXIF; HTML renamed `.jpg` refused; > 5 MB refused.
- E2E: org admin creates and submits a campaign with a cover; platform admin approves (ECB mocked at the server boundary); publish button shown (signing is not automated in E2E — the linking step is covered by integration tests); axe on all new pages.
- Deliberate breaks: remove the org-membership check on draft creation; remove the `floor` in the USDC math.

### Docs

ADR-035…038; technical 01 (campaign lifecycle Phase 1), 02 (who calls createCampaign), 03 (new columns, enum value), 04 (routes/pages), 05 (public bucket), 06 (image metadata stripping, operator signing), 08 (how to review and publish a campaign; gas), 09. CHEATSHEET (public bucket, operator wallet needs POL). Labels: Built until David confirms on dev.

## Must not touch

Contracts (no redeploy), indexer code (reading its views is fine; if a view lacks a needed column, stop and report), `.kamal/secrets*`, `.env*` (except `.env.example` placeholders), private-file code beyond reuse.

## Acceptance (per PR)

- Plan approved before code; split proposed if over ~800 lines (excluding lockfile, generated snapshot and docs).
- Migration backward compatible; tests listed for the PR pass; deliberate breaks shown.
- Lint/typecheck clean; web tests, db integration, E2E for touched pages green; **no local docker build** — CI "Image build" must be green.
- `grep` of the diff: no secret values, no server IP, no real personal data.
- Docs updated as listed; feedback names the chapters.
- On dev after merge (David): one campaign published on Amoy and linked; measured gas of `createCampaign` written into technical 02/08.

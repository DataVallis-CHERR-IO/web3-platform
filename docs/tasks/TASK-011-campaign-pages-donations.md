# TASK-011 — Public campaign pages and the donation flow

Written by the cloud CTO session on 2026-10-03; David approved the split into three PRs and the donor-list rule (ADR-043).
Depends on: TASK-010 (DEPLOYED campaigns, `chain` views), TASK-030 (media, ADR-039), TASK-031 (display currency, ADR-040), TASK-032 (design system v1.1, ADR-041).
Model: strong (money, on-chain transactions, personal data in the donor list).

Three PRs, each with its own branch, feedback file and docs update:

| Part | Branch | Feedback |
|---|---|---|
| 011a — public campaign pages (read-only) | `feat/TASK-011a-campaign-pages` | `TASK-011a.feedback.md` |
| 011b — donation from a wallet (approve + donate, failure preference) | `feat/TASK-011b-wallet-donation` | `TASK-011b.feedback.md` |
| 011c — smart account + sponsored gas for embedded wallets | `feat/TASK-011c-smart-account` | `TASK-011c.feedback.md` |

## Goal

At the end of TASK-011 a visitor can browse live campaigns and open a campaign page that shows the story, photos, videos, documents, progress and every donation, with proof. A logged-in donor can donate USDC on Polygon from their wallet, chooses what happens to the money if the campaign fails, and can change that choice while the campaign is live. Donors with a wallet created by CHERR.IO pay no network fee (011c).

**Not in this task:** card payments via Transak (TASK-012), payouts, evidence, voting, refunds and pool claims (TASK-013), Emergency Pool pages (TASK-014), ratings (TASK-015), the public REST API / OpenAPI, the embeddable widget, JSON-LD, and switching the landing page from fixtures to real campaigns (follow-up; the landing keeps its sample data until there are real campaigns on prod).

## Rules this task must follow (already decided)

- Product Spec §2.2: USDC on Polygon only; **minimum donation 1 USDC** (`PlatformConfig.minDonation`, default `1e6`); a donation above the remaining target is **clipped** by the contract; failure preference `REFUND` (default) or `EMERGENCY_POOL` with an optional sub-pool, changeable while the campaign is live; donors may appear anonymous (display only).
- `users.anonymous_donations` (set on `/account`) is the anonymity switch; it applies to every donation of that user.
- ADR-003 / ADR-024: Privy for all logins; embedded wallets become ERC-4337 smart accounts with Alchemy Gas Manager sponsorship (011c). External wallets pay their own gas (`docs/guides/donors.md`).
- ADR-036 / ADR-040: targets are EUR with a stored ECB snapshot; on-chain amounts are USDC `bigint`; every amount on screen goes through `UsdcAmount` / `EurAmount` (display currency, "≈" + exact original).
- ADR-039: videos only through `youtube-nocookie.com` / Vimeo with `dnt=1` (`videoEmbedUrl()` in `packages/shared`).
- ADR-041 + `packages/ui/design-system/README.md` "Campaign page" layout: photo + story in 8 columns with a sticky donate panel in 4 columns (Progress, amount field in EUR, one primary button, ProofLink); "How your money is protected"; `#proof` "Every donation, on the blockchain" with LedgerTable and the contract Address; eyebrow + section heading; bands; cherry key figure; mobile: the donate panel becomes a bottom bar.
- Human layer: no Web3 words outside the proof layer and the wallet option label; errors say how to fix the problem ("The minimum donation is €1.").
- The web app reads on-chain state only from `chain.*` views (ADR-026), never from an RPC on the server.

## Decision added with this spec

| ID | Date | Status | Decision | Reason |
|---|---|---|---|---|
| ADR-043 | 2026-10-03 | Accepted | **Public donor list (David, 2026-10-03).** Every donation is listed on the campaign page with **display name, amount, time and a link to its transaction**. A user with `anonymous_donations = true` is shown as "Anonymous" (amount, time and tx link stay). An address that is not linked to a CHERR.IO user is shown as a shortened address (`0x1a2b…9f3c`). The name ↔ address link is personal data: it is shown only while the user exists and has not chosen anonymity, and it disappears when the account is erased (the `user_addresses` row is deleted). | Donations are public on-chain anyway; showing the proof per row is the transparency CHERR.IO promises. Anonymity stays a one-click choice. |

## 011a — public campaign pages (read-only)

### Pages
- `/[locale]/campaigns` replaces the "coming soon" page: a grid of `CampaignCard`s for campaigns with `app.campaigns.status = 'DEPLOYED'` and a linked `onchain_address`. Order: on-chain state `LIVE` first (soonest deadline first), then ended campaigns (newest end first). 24 per page with `?page=` pagination.
- `/[locale]/campaigns/[slug]` — the campaign page (404 for unknown slugs and for campaigns that are not DEPLOYED). Sections, in this order:
  1. Hero: cover photo (8 columns) + organisation name with the verified mark + title + cause/country; sticky panel (4 columns) with Progress (raised vs target, 10 % success line), donor count, days left / ended state chip, and a ProofLink to `#proof`. In 011a the panel has **no donate button yet** (011b adds it).
  2. Story (plain text, `body-lg`, max 65ch), gallery images, videos (iframe with the embed URL, `title` attribute, lazy), public documents (links).
  3. "How your money is protected": one sentence per payout rule (escrow, 10 % success line, 72 h release delay or three steps with donor votes once the payout mode is known); no MilestoneTrack until TASK-013.
  4. `#proof` "Every donation, on the blockchain": LedgerTable of donations (newest first, 50 per page) with donor per ADR-043, amount (`UsdcAmount`), time, tx link ↗ to the explorer; the campaign contract `Address` with an explorer link.
- `generateMetadata`: title, description (first 160 characters of the story), `og:image` = cover.
- `CampaignCard` gets an optional `href` (the whole card is one link; focus-visible style). `Progress` gets optional `raisedLabel` / `targetLabel` (ReactNode) so the server can pass `UsdcAmount` / `EurAmount`; the bar ratio uses USDC raised vs USDC target.

### Data (`apps/web/src/lib/campaigns/public.ts`, server only)
- `listPublicCampaigns({ page })`, `getPublicCampaign(slug)`, `listCampaignDonations(address, { page })`.
- Join `app.campaigns` (DEPLOYED) with `chain.campaign` on `onchain_address`; donations from `chain.donation`; donor count from `chain.campaign_donor`. Raw SQL with `::text` casts like `linkDeployedCampaign` (no per-deploy enum types).
- Donor names: `chain.donation.donor` → `app.user_addresses.address` → `app.users` (`display_name`, `anonymous_donations`).
- If the `chain` schema/views are missing (`isMissingRelation`), pages still render from `app.*` data with an "on-chain figures are temporarily unavailable" notice — never a 500.
- Explorer base URL comes from the chain config by `APP_ENV` (amoy.polygonscan.com / polygonscan.com), never hard-coded in components.

### Tests
- Vitest (real Postgres, `chain.*` created as tables in the test like `campaign-publish.test.ts`): listing filters and order, slug 404 for DRAFT/APPROVED, donor naming (named, anonymous, unknown address), missing-`chain` fallback, pagination bounds.
- Playwright: seed a DEPLOYED campaign + fake `chain` rows; list → card → campaign page; donor list shows a name, "Anonymous" and a short address; axe on both pages.
- Deliberate break for the anonymity rule (show the name although `anonymous_donations = true`) must fail a test.

## 011b — donation from a wallet

- Donate panel (client component) on the campaign page while the on-chain state is `LIVE` and the deadline has not passed: amount field in **EUR** (quick amounts €10 / €25 / €50 / €100), converted to USDC with the latest stored ECB rate (`fx` tables); if no rate is usable the field is in USDC. "Details" shows the exact USDC amount before confirming. Validation: ≥ 1 USDC ("The minimum donation is €1."); above the remaining target the panel says only the missing amount will be taken and uses that amount.
- Failure preference: "Refund to me" (default) or "Send it to the Emergency Pool" with an optional theme from `app.emergency_subpools` that also exists in `chain.pool` (general pool = 0).
- Not logged in → the button opens the Privy login and comes back to the panel.
- Transaction flow over the wallet's EIP-1193 provider with viem (pattern of `publish-client.ts`, 30 gwei minimum tip): switch to the campaign's chain → read USDC balance and `remaining()` → if allowance < amount, `approve(campaign, amount)` (exact amount, never unlimited) → `donate(amount, pref, subPoolId)` → wait for the receipt → success state with a ProofLink to the transaction. Errors mapped to fixable messages: not enough USDC (on testnet: link to Circle's faucet), rejected in wallet, wrong network, campaign ended, timeout (the tx link stays visible).
- "Your donation" box for a logged-in donor (sum over their linked addresses from `chain.campaign_donor`) with the current failure preference and a "Change" action that calls `setPreference(pref, subPoolId)` while LIVE.
- After a confirmed donation the page refreshes its server data; the new row appears once the indexer has it ("Recorded on the blockchain — it appears in the list within a minute").
- Tests: unit tests for the EUR→USDC conversion and minimum/clip rules (bigint only), the transaction helper against a fake provider (approve skipped when allowance suffices, exact approve amount, error mapping), Playwright for the panel states with a mocked provider; deliberate break: unlimited approve must fail a test.

## 011c — smart account and sponsored gas

- Enable Privy smart wallets (`@privy-io/react-auth/smart-wallets`, `SmartWalletsProvider`, peer `permissionless`) for users whose wallet is the embedded one; external wallets keep 011b's path and pay their own gas.
- Donation with a smart account: **one batched user operation** `[approve(exact), donate]`, sponsored by the Alchemy Gas Manager policy configured in the Privy dashboard; `setPreference` sponsored as well.
- The smart-account address is synced to `user_addresses` as `SMART_ACCOUNT` (the donor address on-chain), so the donor list (ADR-043) and "Your donation" find it.
- Fallback: if sponsorship is refused (policy limit), say so plainly and offer the non-sponsored path only if the account holds POL.
- Docs: 06-security (sponsorship abuse, policy limits), 05 (any new env var), guides (donors: "free with a wallet created by CHERR.IO" becomes live).
- **Setup by David before 011c can be proven on dev** (values never in chat or repo): Alchemy Gas Manager policy for Polygon Amoy with per-address limits; Privy testnet app → Smart wallets enabled (type chosen by David), Amoy bundler + paymaster URLs with the policy ID. If the code needs the policy ID as an env var, it is added as a GitHub secret by David.

## Docs to update (every part)
`docs/technical/04` (pages, components, flows), `03` (new readers of `chain` views), `07` (tests), `09` (status), `06` and `05` in 011c, `docs/guides/donors.md` when donating becomes possible on dev, and the feedback file with real outputs and the deliberate breaks.

# TASK-057 — Ratings of organisations (ADR-058)

Owner decision: ADR-058 (David 2026-10-08: rate finished campaigns for 90 days; optional private comment; signed with the wallet). Order: sharing (055) → Proof of Charity v2 (056) → **this** → registry import (TASK-016) → Charity Market Cap (TASK-017).

## Goal
Donors rate the organisation behind a finished campaign, 1–5 stars, signed with their wallet. The average feeds the payout-mode suggestion (ADR-049, already reads `app.ratings`) and, later, Trust Score v1 (Product Spec §4, 30 % weight). A rating earns 20 points and completes the Guardian condition (ADR-057).

## Parts (expand rule from HANDOFF)
- **057-schema** — migration `0018` only: `ratings.signer_address` (lower-case check), `ratings.signed_at`, index `ratings_created_at_idx`. No code reads the new columns.
- **057a** — rate and earn:
  - `packages/shared/src/ratings.ts`: EIP-712 domain `{ name: "CHERR.IO", version: "1", chainId }` (chain from `APP_ENV`), type `Rating { campaign: address, organization: string, stars: uint8, commentHash: bytes32, issuedAt: uint64 }` (`commentHash` = keccak256 of the UTF-8 comment, zero hash without one), `RATING_WINDOW_DAYS = 90`, comment ≤ 1,000 characters.
  - `lib/ratings/` (web): eligibility (campaign of an organisation; state `COMPLETED`/`FAILED`/`REJECTED`; window start = last `tranche_release.block_time` for `COMPLETED`, else `settlement_start` if set, else `end_time`; the user has a linked address in `chain.campaign_donor` with `donated > 0`; not an org member, not the starter), signature check (`signer` must be one of the user's linked addresses; local recover for EOAs, `publicClient.verifyTypedData` — ERC-1271 / ERC-6492 — for smart accounts; `issuedAt` within 10 minutes of the server clock), upsert on `(campaign_id, user_id)`.
  - Routes: `GET /api/campaigns/[slug]/rating` (eligibility, window end, own rating), `POST` same path `{ stars, comment?, signer, issuedAt, signature }` — session, origin check, rate limit, audit `rating.saved`.
  - UI: "Rate the organisation" panel on the campaign page for eligible donors (stars as a radio group, optional comment with a "Only the organisation and CHERR.IO see this" note, "Sign and save"); "My donations" links to it while the window is open.
  - Worker: `awardPoints` credits `RATING` 20 once per campaign (`ref_key rating:<campaign id>`), watermark on `ratings.created_at` + the full pass; own organisation excluded (also checked at write).
  - GDPR `eraseUser`: also nulls `signer_address` and `comment`.
- **057b** — show: organisation average and count (public; organisation page now, Market Cap in TASK-017), comments for the organisation's members (`/en/account/organization`) and admins (campaign admin page).

## Must not touch
Contracts, the indexer schema, the payout-suggestion rule (ADR-049).

## Tests
Vitest against Postgres + fake chain: eligibility per state and window edge, non-donor / org member / starter refused, individual campaign refused, signature from a non-linked address refused, wrong stars/comment hash refused, stale `issuedAt` refused, second rating updates (one row), EOA signature with a viem test account; smart-account path with a stubbed verifier. Worker: 20 once, own organisation nothing, watermark + full pass. E2E: an eligible donor (session helper + test wallet signer) rates, sees the saved rating; a11y. Deliberate breaks in the feedback file.

## Docs
`docs/technical/03` (ratings table, points), `04` (routes, panel), `06` (signature verification), `09`; `docs/guides/donors.md` and `cherrions.md` (mark rating points live).

# TASK-057 feedback — Ratings of organisations (ADR-058)
Spec: `docs/tasks/TASK-057-ratings.md`. Owner decision: ADR-058 (David 2026-10-08).

## 057-schema (PR #163)
Status: DONE — Live on dev (merged 2026-10-08, all checks green). Migration `0018`: `ratings.signer_address` (lower-case check), `ratings.signed_at`, `ratings_created_at_idx`. `pnpm --filter @cherrio/db test:integration` → `Tests 18 passed (18)` after `db:migrate`.

## 057a — rate and earn
Status: DONE — Live on dev (PR #164 merged 2026-10-08, all checks green; Deploy run 37734554022 green: web + migrate, indexer, worker)

### What I implemented
- `packages/shared/src/ratings.ts` (export `./ratings`): EIP-712 domain/types, `ratingTypedData`, `ratingCommentHash`, `RATING_WINDOW_DAYS = 90`, `RATING_COMMENT_MAX = 1000`, `RATEABLE_CAMPAIGN_STATES`, 10-minute `issuedAt` tolerance.
- `apps/web/src/lib/ratings/index.ts`: `ratingWindowStart`, `loadRatingContext` (status, window end, own rating), `saveRating` (input checks → eligibility → signer must be a linked address → EOA recover, else ERC-1271/6492 via `chainSignatureVerifier()` for a `SMART_ACCOUNT` → upsert that only replaces an older signature → audit `rating.saved` without the comment).
- `GET/POST /api/campaigns/[id]/rating` (session, origin check on POST, `ratingRateLimiter` 20 / 10 min per user).
- `components/campaigns/RatingPanel.tsx` on the campaign page (finished organisation campaigns), `Signer.signTypedData` for the Privy smart account; "My donations" link/"You rated it N of 5"; messages `campaignPage.rating.*`, `myDonations.action.rate|rated`; CSS `.ch-rating`.
- Worker `awardPoints`: `RATING` 20, `rating:<campaign id>`, watermark on `ratings.created_at` (same as users), own organisation excluded, unsigned rows skipped.
- GDPR `eraseUser`: nulls `signature`, `signer_address` and `comment`.
- Test helpers: fake chain `tranche_release`; E2E wallet answers `eth_signTypedData_v4` through `installSigningKey` (a real test key in Node, so the server really verifies); `deleteTestUser` removes ratings.

### Deviations
- API path is `/api/campaigns/[id]/rating` (campaign UUID, like the existing `[id]` routes), not `[slug]`.
- Eligibility reads `chain.donation` (anyone who donated, even if later refunded), not `campaign_donor.donated > 0`.
- The panel signs with the first available signer (external wallet first, then the smart account); no address picker. Any linked address is accepted by the server.
- The smart-account path (ERC-1271/6492) is tested with a stubbed verifier; the real on-chain check is not exercised in CI (no deployed smart account in the test chain).

### Test results
Web `src/__tests__/ratings.test.ts` (7 new) — full web suite:
```
 Test Files  64 passed (64)
      Tests  545 passed (545)
```
Worker (1 new rating test): `Tests  14 passed (14)`. Shared: `Tests  105 passed (105)`. DB integration (GDPR rating assertion added): `Tests  18 passed (18)`. Typecheck and lint (all packages but contracts): no errors. `check:design`: "Design check passed — no violations found."

Deliberate breaks (each restored):
1. Linked-address check removed in `saveRating` →
```
   × saving a signed rating > refuses a changed message, a foreign or unlinked signer, a stale time and wrong input 89ms
     → expected { ok: true, created: true } to deeply equal { Object (ok, error) }
      Tests  1 failed | 6 passed (7)
```
2. Own-organisation exclusion removed from the worker's rating award →
```
   × points (ADR-057) > a signed rating: 20 once per campaign, on the next minute tick; nothing unsigned or for your own organisation (ADR-058) 81ms
     → expected 2 to be 1 // Object.is equality
      Tests  1 failed | 13 passed (14)
```

E2E (local production build) `rating.spec.ts` (new: donor signs 4 stars + comment, saved row has the signer, "Sign and update", My donations shows "You rated it 4 of 5"; non-donor sees no panel; axe WCAG 2.1 AA) with `lifecycle`, `impact`, `campaign-pages`:
```
  20 passed (1.1m)
```
Screenshots at 1440 and 390 checked by eye (not committed).

### Open questions / risks
- `chainSignatureVerifier` depends on the RPC upstreams; if they are down, a smart-account rating fails with "signature did not match" (EOAs are unaffected).

## Suggested commit message
feat(ratings): signed ratings of organisations after a finished campaign (TASK-057a)

## 057b — showing ratings
Status: DONE — Live on dev (PR #170 merged 2026-10-08, all checks green; Deploy run 37764999469 green)

### What I implemented
- `lib/ratings`: `orgRatingSummaries(db, orgIds)` (average rounded to one decimal, count; one query) and `listRatings(db, { orgId } | { campaignId })` (stars, comment, campaign title, date — no rater fields).
- Public: campaign page meta line "★ 4.3 (12)" next to the organisation (`RatingSummary`, accessible name "Rated 4.3 of 5 by 12 donors"); `PublicCampaignSummary.orgId` added.
- Private: `/en/account/organization` — a "Ratings from donors" panel for every **verified organisation the user is a member of** (summary + `RatingList` with the comments); admin campaign page — "Donor ratings" of that campaign; admin organisation page — summary + all ratings.
- CSS `.ch-rating-summary`, `.ch-rating-list*`; messages `ratings.*`; fundraiser guide updated.

### Deviations
- There is no public organisation page yet (TASK-017 builds the organisation profile on the Charity Market Cap), so the public average is shown on campaign pages for now.
- The member panel is based on membership + KYB status, not on the user's own KYB submission (an organisation can have members who never submitted).
- The average is the plain mean; the Bayesian average (prior 3.5, C = 5) belongs to Trust Score v1 (TASK-017).

### Test results
`ratings.test.ts` (new "showing ratings" test: per-campaign list exact, no rater fields, org average = rounded mean of the list, empty input): `Tests 8 passed (8)`. Deliberate break — campaign filter of `listRatings` replaced by a no-op:
```
   × showing ratings (TASK-057b) > average and count per organisation; the list has stars, comment and campaign — never who rated 88ms
     → expected [ [ 2, 'Slow updates' ], …(4) ] to deeply equal [ [ 2, 'Slow updates' ], [ 4, null ] ]
      Tests  1 failed | 7 passed (8)
```
restored → `Tests 8 passed (8)`. Full web suite: `Test Files 64 passed (64)`, `Tests 547 passed (547)`. Typecheck, lint, `check:design`: clean.
E2E `rating.spec.ts` (+ public page shows "Rated 4.0 of 5 by 1 donor" and not the comment; new: the organisation's member reads the private comment, the rater is not named, axe clean) with `organization.spec.ts` and `campaign-pages.spec.ts`: `14 passed (1.1m)`. Panel screenshot checked by eye.
CI (first run): two E2E failures. (1) The "no comment on the public page" check found the donor's own comment in the rating panel's text box — now checked in a visitor context without a session. (2) `display-currency.spec.ts` (also flaky on #166): the web server keeps FX rates in memory for 30 s, and a spec that ran just before had loaded rates without CHF; the spec now reloads until the fresh rates are read (≤ 45 s). Local re-run of `campaign-card-layout` + `display-currency` + `rating` in one worker: `10 passed (1.2m)`.

## Suggested commit message (part b)
feat(ratings): show the average publicly and the private comments to the organisation and admins (TASK-057b)

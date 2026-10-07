# TASK-055 feedback — campaign sharing with personal links (part a)
Status: DONE (part a; the share image is part b)

David 2026-10-07: "ja, se strinjam" to the order *sharing → Proof of Charity v2 → ratings → registry import*; ADR-057 §5 (attributed sharing) the same evening. No separate spec; ADR-057 and this file are the record.

## What I implemented
- **Share box** on every campaign page (`components/campaigns/CampaignShare.tsx`, under "See every donation" in the panel): X, Facebook, LinkedIn, WhatsApp, Telegram and email links in a 3-column grid, "Copy link" (with a screen-reader status "Link copied"), and "More ways to share" when the browser has `navigator.share` (phones). Styles `.ch-share*` in `packages/ui/src/styles/components.css` (tokens only; checked at 1440 and 390 px).
- **Personal link:** every signed-in user gets an 8-character code (`a–z` without i/l/o, `2–9`), created on first use (`GET /api/me/referral-code`, `lib/referrals.ts` `getOrCreateRefCode`, safe when two first uses race). The box shares `…/en/campaigns/<slug>?ref=<code>` and says "This is your personal link…"; without a session it shares the plain link and says "Log in to share your personal link…". Links always use the environment's public origin (`getExpectedOrigin`), never the container address.
- **First-touch cookie:** `middleware.ts` sets `cherrio_ref` (httpOnly, Lax, Secure outside local, 30 days) for a well-formed `?ref=` on any page, only when no valid one exists (`lib/referral-cookie.ts`, edge-safe).
- **Friends who join:** `POST /api/auth/session` stores `users.referred_by_user_id` from the cookie when it creates a user; later logins never change it.
- **Who brought a donor to a campaign:** the donate box calls `POST /api/referrals { campaign }` (fire and forget, `keepalive`) when a donation starts; the server records `campaign_referrals (user, campaign → referrer)` — first touch per campaign wins, never yourself, published campaigns only. Same-origin check, session, 30 requests/min per IP.
- **Data:** migration `0016_campaign_referrals.sql` — `users.ref_code` (unique, format check), `users.referred_by_user_id` (FK, not-self check), table `campaign_referrals` (PK user+campaign, not-self check, index by referrer). Additive only.
- **GDPR:** `eraseUser` nulls `ref_code` and `referred_by_user_id` and deletes the user's `campaign_referrals` rows; rows where they were the referrer stay (anonymised user, link gone).
- Nothing awards points yet: TASK-056 will credit only donations the chain confirms from the user's linked addresses.

## Files changed
- `packages/db/src/schema/users.ts`, `packages/db/src/schema/social.ts`, `packages/db/drizzle/0016_campaign_referrals.sql` (+ snapshot, journal), `packages/db/src/gdpr.ts`, `packages/db/src/__tests__/integration.test.ts` (26 tables; erase clears the new fields).
- `apps/web/src/lib/referral-cookie.ts`, `apps/web/src/lib/referrals.ts` (new), `apps/web/src/middleware.ts`, `apps/web/src/app/api/auth/session/route.ts`, `apps/web/src/app/api/me/referral-code/route.ts`, `apps/web/src/app/api/referrals/route.ts` (new), `apps/web/src/lib/security/rate-limit.ts`.
- `apps/web/src/components/campaigns/CampaignShare.tsx` (new), `apps/web/src/components/campaigns/DonatePanel.tsx` (`rememberReferral`), `apps/web/src/app/[locale]/campaigns/[slug]/page.tsx`, `apps/web/messages/en.json` (`campaignPage.share`), `packages/ui/src/styles/components.css`.
- Tests: `apps/web/src/__tests__/referrals.test.ts` (10), `apps/web/e2e/campaign-share.spec.ts` (2 × 2 viewports), `apps/web/e2e/helpers/session.ts` (`deleteTestUser` clears referral rows).
- Docs: `docs/technical/03`, `04` (§4 campaign page, §5.3a, §7 API), `09`, `docs/tasks/README.md`, `docs/guides/cherrions.md` (sharing + ADR-057 points and levels, marked as being built).

## Deviations
- Split in two PRs: the **share image** (cover + progress bar as the link preview) follows as part b. Today the preview uses the existing `openGraph` title, description and cover.
- No icons on the network buttons: the web app has no icon set; text buttons in the design system's style.
- Points for referrals are **not** in this PR (TASK-056).

## New dependencies
- none

## How to verify
1. `pnpm --filter @cherrio/db migrate`, then `pnpm --filter web test` → 530 passed; `pnpm --filter @cherrio/db test:integration` → 18 passed.
2. `cd apps/web && pnpm build && CI=1 pnpm exec playwright test e2e/campaign-share.spec.ts` → 4 passed.
3. On dev after the deploy: open any campaign at https://dev.cherr.io/en/campaigns → right panel "SHARE THIS CAMPAIGN"; logged in, "Copy link" copies a link ending in `?ref=` + 8 characters.

## Test results
Referral tests:
```
 ✓ src/__tests__/referrals.test.ts (10 tests) 248ms
 Test Files  1 passed (1)
      Tests  10 passed (10)
```
Deliberate breaks (each restored afterwards, then `Tests  10 passed (10)`):
1. First touch disabled in `firstTouchRefCode` (a later link replaces the cookie):
```
   × first-touch cookie > is set only for a well-formed ?ref= and never replaces an earlier one 9ms
     → expected 'abcdefgh' to be null
      Tests  1 failed | 9 passed (10)
```
2. Referrer not stored at registration (`referredByUserId: referredByUserId && null`):
```
   × registration through a share link > stores who brought a new user; a later login with another code changes nothing 24ms
     → expected null to be '01a117ef-c544-7471-b648-74e9b944192d' // Object.is equality
      Tests  1 failed | 9 passed (10)
```
3. `eraseUser` keeps the campaign referrals:
```
   × erasing a user (GDPR) > removes their share code, who brought them, and their campaign referrals 33ms
     → expected [ { …(4) } ] to deeply equal []
      Tests  1 failed | 9 passed (10)
```
Full suites:
```
web:    Test Files  61 passed (61) · Tests  530 passed (530)
worker: Tests  8 passed (8)
db integration: Tests  18 passed (18)
E2E campaign-share.spec.ts: 4 passed (13.9s)
```
Typecheck and lint of all packages: no errors (one `no-empty-pattern` in the new spec fixed before the commit). `pnpm check:design`: passed.

Screenshots (temporary spec, not committed): at 1440 the box sits under "See every donation" in the sticky panel, six buttons in two rows of three, "Copy link" full width, the personal-link note below; at 390 the same three columns fit without wrapping ("WHATSAPP", "TELEGRAM" fit).

## Open questions / risks
- A visitor who blocks cookies is not attributed — acceptable.
- Attribution is per user account: a donor who never signs in (wallet only, no session) is not attributed; donating through the app requires a sign-in today.

## Suggested commit message
feat(share): campaign share box with personal ?ref links and first-touch attribution (TASK-055a)

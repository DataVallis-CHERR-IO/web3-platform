# TASK-011a feedback — public campaign pages
Status: DONE (Built; becomes Live on dev with the merge of this PR)

Implemented by the cloud CTO session, 2026-10-03, against `docs/tasks/TASK-011-campaign-pages-donations.md` §011a and ADR-043.

## What I implemented
- `/en/campaigns`: the "coming soon" page is replaced by the public list. It shows every `DEPLOYED` campaign that has a linked contract, as linked `CampaignCard`s. Live campaigns come first (soonest deadline), then ended ones (latest end). There are 24 per page, and `?page=` is clamped.
- `/en/campaigns/[slug]`, the campaign page laid out per the design system:
  - **Hero:** cover in 8 columns plus a sticky panel in 4 columns. The panel shows the cherry key figure (raised), the target, Progress with the 10 % line, donors and days left, and a ProofLink to `#proof`.
  - **Meta:** state chip, organisation with the verified mark, cause, country, title.
  - **Content:** the story, gallery, videos (youtube-nocookie / Vimeo `dnt=1` iframes) and public PDFs.
  - **"How your money is protected":** a tint band with the escrow rule, the 10 % rule, and the payout rule taken from the on-chain `payout_mode`. Until the campaign is finalized it describes both payout options.
  - **`#proof` "Every donation, on the blockchain":** the contract address with a copy button and an explorer link, and the donation ledger. The ledger is newest first, 50 per page (`?donations=`), and shows per row the donor per ADR-043, the USDC amount, the UTC time and a tx link.
  - **Metadata and errors:** `generateMetadata` (title, description, `og:image`). Unknown or non-DEPLOYED slugs return 404.
- Read model `apps/web/src/lib/campaigns/public.ts`. It reads `app.*` plus the `chain.*` views with raw SQL (columns by name, `::text`) and takes no data from RPC.
  - If the `chain` views are missing, the pages render from `app.*` with a notice. Any other database error is rethrown.
  - Donor naming follows ADR-043: the display name, "Anonymous" when `users.anonymous_donations` is set, or the address when no user matches. An address also stops matching after `eraseUser`, because that deletes `user_addresses`.
- UI components:
  - `CampaignCard` gets `href` (the whole card is a link, with hover and focus styles) and `children` (to replace the built-in Progress).
  - `Progress` gets `raisedLabel` / `targetLabel` / `barLabel`, so the server can pass the display-currency amounts (`UsdcAmount` / `EurAmount`).
  - `LedgerTable` gets `fromDisplay`, `txAriaLabel`, `explorerBase: null`, and a focusable, named scroll region.
- `MediaView.videos[].embedUrl` is added.
- Shared test helper `src/__tests__/helpers/fake-chain.ts`. It stands in for the `chain.*` views, guarded by an advisory lock. Both the vitest suite and Playwright use it, and `campaign-publish.test.ts` now uses it too.

## Files changed
- `apps/web/src/app/[locale]/campaigns/page.tsx`: the public list (was ComingSoon).
- `apps/web/src/app/[locale]/campaigns/[slug]/page.tsx`: new campaign page.
- `apps/web/src/lib/campaigns/public.ts`: new read model.
- `apps/web/src/components/campaigns/public-display.ts`: chip mapping, days left, percent.
- `apps/web/src/lib/campaigns/publish.ts`: `isMissingRelation` is now exported (shared).
- `apps/web/src/lib/campaigns/media-view.ts`: `embedUrl` for videos.
- `apps/web/messages/en.json`: new `campaignPage.*` namespace.
- `packages/ui/src/components/CampaignCard.tsx`, `Progress.tsx`, `LedgerTable.tsx`, `packages/ui/src/styles/components.css`: the component additions above and the page layout CSS.
- `packages/ui/design-system/components/CampaignCard/README.md`, `LedgerTable/README.md`: usage notes.
- Tests:
  - `apps/web/src/__tests__/public-campaigns.test.ts` (new, 11 tests);
  - `helpers/fake-chain.ts` (new);
  - `campaign-publish.test.ts` (uses the helper);
  - `apps/web/e2e/campaign-pages.spec.ts` (new);
  - `e2e/auth-nav.spec.ts` (`/en/campaigns` is no longer a coming-soon page).
- Docs: `docs/technical/03`, `04`, `07`, `09`.

## Deviations from the task (and why)
- **LedgerTable keyboard-scroll a11y (an open item in HANDOFF) is fixed here.** axe failed `scrollable-region-focusable` on the 390 px viewport, because a local chain has no explorer links and so nothing in the table was focusable. The wrapper is now `role="region"`, `tabIndex=0` and named.
- **The success line stays at 10 %.** The indexer does not expose the per-campaign snapshot `snapSuccessThresholdBps`, and 10 % is the product rule (Product Spec §2.3).
- **The landing page still uses sample data.** This was out of scope in the spec.
- **Size:** about 1,430 added lines including tests (~450), messages (~75), docs and CSS. The app code is about 650 lines.

## New dependencies
- none

## How to verify (on dev after deploy)
1. Open https://dev.cherr.io/en/campaigns. The heading "CAMPAIGNS" shows. Below it there is either the card of each published Amoy campaign or the text "No campaigns are raising money yet."
2. Click a card. `/en/campaigns/<slug>` opens with the cover, story, the panel "raised of the € … target", the section "How your money is protected", and "Every donation, on the blockchain" with the contract address and a "View the contract on the block explorer ↗" link.
3. `/en/campaigns/does-not-exist` returns 404.

## Test results (real, this session)
- `pnpm --filter web test` → `Test Files 28 passed (28)`, `Tests 197 passed (197)`. `public-campaigns.test.ts` has 11 tests.
- **Deliberate break (ADR-043):** the anonymity rule was removed from `donorName`.
  - Result: `× names donors per ADR-043: name, Anonymous, or the address of an unknown donor` and `× donorName: unknown when no user row matched`, giving `Tests 2 failed | 9 passed (11)`.
  - After restoring: `Tests 11 passed (11)`.
- **E2E**, after `pnpm build`: `CI=1 pnpm exec playwright test --retries=0` → `116 passed (2.6m)`.
  - The first runs failed for real reasons, and both were fixed:
    - axe `scrollable-region-focusable` on `.ch-ledger-wrap` (390 px viewport);
    - the old `auth-nav` test still expected "Back to Home" on `/en/campaigns`.
- `pnpm --filter='!@cherrio/contracts' typecheck` and `lint`: no errors.
- `pnpm check:design` → `Design check passed — no violations found.`
- Foundry and the indexer suites were not run here, because this PR does not touch them. Foundry is not installed in the sandbox; CI runs both.

## docs/technical chapters updated
- 03 (§2.5 new reader of `chain` views; status row), 04 (pages, components, sources), 07 (E2E coverage, counts), 09 (TASK-011 row).

## Open questions / risks
- Pages are rendered per request: the display-currency cookie and the DB make them dynamic. The E2E proves that data inserted after the server started appears. The list query does a `count(*)` subquery per row, which is fine for Phase 1 volumes (≤ a few hundred campaigns).
- Since #49 the indexer polls every 60 s, so a new donation can take up to about a minute to appear.

## Suggested commit message
feat(web): public campaign list and campaign page with donor ledger (TASK-011a)

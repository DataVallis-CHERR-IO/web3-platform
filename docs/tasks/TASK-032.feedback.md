# TASK-032 feedback (design accents, design system v1.1)
Status: DONE (Built; Live on dev after the deploy)

Numbering: the CTO's task file is "TASK-029-design-accents" with "ADR-039". Both numbers were taken in the repository (TASK-029 UX fixes, ADR-039 media, ADR-040 display currency). It is therefore filed as **TASK-032** with **ADR-041**; the content is unchanged.

## What I implemented
- **ADR-041.**
- **Tokens:**
  - `cherry-50`, `cherry-100`, `success-700`, `success-50`, `warning-700` and `warning-50` with the specified light/dark values;
  - semantic `status-success-fill` / `on-status-success` (fill in light, text in dark);
  - `wayfinding-text` (see deviations);
  - in `tokens.json` → generated `src/styles/tokens.css`, and the exported `design-system/tokens.css`.
- **Header:**
  - 6px cherry top rule;
  - the current section's nav item gets `aria-current="page"` (desktop and mobile menu) and shows cherry text with a 3px cherry underline.
- **Eyebrow** (`.ch-eyebrow`, also the landing tagline and step labels): cherry dash and cherry text. On the dark step and on the Emergency Pool block the text keeps the block's colour (cherry text fails contrast there); the dash stays.
- **Section heading** (`.ch-section-heading`, also the landing headings): display face 44px / 30px mobile, 72×8 cherry bar. Used on every app page title (account, organisation, campaigns, admin pages, coming-soon pages).
- **Key figures and links:** the raised amount in Progress, Charity Market Cap scores, Trust Score, ProofLink and the Charity Market Cap link.
- **Bands** `.ch-band-tint` / `.ch-band-raised`: full-bleed via box-shadow + clip-path; the raised band's 3px rules are full-bleed via `border-image` outset, without page overflow.
  - Landing: steps (tint, with an eyebrow and a heading) → campaigns (ground, with an eyebrow) → Charity Market Cap (raised) → Emergency Pool (dark, 12px cherry left edge).
- **Status chips:**
  - LIVE: cherry;
  - VERIFIED / SUCCEEDED / COMPLETED: success;
  - VOTING and the new `in-review` chip (`…`): warning;
  - PENDING / IMPORTED: `ink-muted` dashed outline;
  - REJECTED / FAILED: cherry-900.
  - Campaign `PENDING_REVIEW` and KYB `PENDING` now use `in-review`; DRAFT stays an outline.
  - The verified mark uses the success fill.
- **Featured CampaignCard:** cherry hard shadow.
- **Copy:**
  - tagline "GIVING YOU CAN VERIFY";
  - the hero photo placeholder moved into `messages/en.json` without "UKC Maribor";
  - footer "Operated by Data Vallis d.o.o.";
  - new eyebrows "IN THREE STEPS" and "CAMPAIGNS" for the two landing sections that had none (rule 1);
  - status label "In review".
- `/dev/ui` shows the new chips (in review, verified, imported).
- Docs: ADR-041, `packages/ui/design-system/README.md` (colour rules, chip table, "Landing & marketing pages"), technical 04 and 09, `tasks/README.md`, the spec in `docs/tasks/TASK-032-design-accents.md`.

## Files changed
- `packages/ui/design-system/{tokens.json,tokens.css,README.md}`, `packages/ui/src/styles/{tokens.css,components.css}`, `packages/ui/src/components/StatusChip.tsx`
- `apps/web/src/components/{AppHeader,ComingSoon}.tsx`, `apps/web/src/app/[locale]/page.tsx` (bands, eyebrows, placeholder text), `dev/ui/page.tsx`
- Page titles: `apps/web/src/app/[locale]/{account/**,admin/**,organizations/new}/page.tsx`, `AccountClient.tsx`
- Chip mappings: `apps/web/src/lib/campaigns/own.ts`, `apps/web/src/lib/admin/organizations.ts`, `admin/kyb/[submissionId]/page.tsx`, `admin/organizations/[id]/page.tsx`, `account/organization/page.tsx`
- `apps/web/messages/en.json`
- `apps/web/src/__tests__/design-contrast.test.ts` (new)
- `apps/web/e2e/{admin-overview,campaign-review,campaigns,kyb-review,organization}.spec.ts` — the axe helper waits for a settled page (title + network idle), as `campaign-media.spec.ts` already did
- `docs/03-DECISIONS.md`, `docs/tasks/TASK-032-design-accents.md`, `docs/tasks/README.md`, `docs/technical/04-web-app-and-auth.md`, `docs/technical/09-status-and-roadmap.md`
- `docs/tasks/screenshots/TASK-032/*.jpg` (10 screenshots)

## Deviations from the task (and why)
- **New token `wayfinding-text`** (light: cherry-700, dark: `#ffd9e4`, the light value of `cherry-100`). The contrast test found that cherry text on a raised surface in the dark theme fails: cherry-500 on slate-700 is **3.05:1**. The spec's "equivalent mapping" therefore uses the light cherry tint for wayfinding text in dark. Light theme is exactly as specified.
- **Raised band background is `surface-raised`, not `white`.** In the dark theme a white band would put light text on white.
- **Outline chip uses `ink-muted`, not `slate-500`.** It is slate-500 in light (identical) and mist-300 in dark (slate-500 on slate-900 would fail).
- **New `in-review` chip** instead of colouring all "pending" chips amber. The spec wants PENDING_REVIEW amber and DRAFT outline, but both used `pending`.
- **Two eyebrows and one heading added on the landing** (steps: "IN THREE STEPS" + "How it works"; campaigns: "CAMPAIGNS") to satisfy rule 1. Please review the wording.
- **Unrelated a11y fix:** the axe helpers of five E2E specs now wait for a settled page. The full run showed the known transient `document-title` flake after `router.refresh()` on the campaign review page; it passed alone and passes with the wait.

## New dependencies
- none

## How to verify
1. `pnpm --filter web test` (includes `design-contrast.test.ts`), `pnpm --filter @cherrio/ui tokens && git diff --exit-code packages/ui/src/styles/tokens.css`
2. `cd apps/web && pnpm check:design`, `CI=1 pnpm exec playwright test --retries=0`
3. Compare `docs/tasks/screenshots/TASK-032/before-*.jpg` with `after-*.jpg`.
4. On dev:
   - `/en`: cherry header rule, eyebrows, tint/raised bands, green VERIFIED chips;
   - `/en/dev/ui` in both themes (footer toggle);
   - `/en/account/campaigns` → a campaign in review shows an amber "In review" chip.

## Test results (this session, 2026-10-03)
- typecheck, lint: pass. `check:design`: "Design check passed — no violations found."
- `web` Vitest: Test Files 26 passed (26), Tests 184 passed (184). Includes `design-contrast.test.ts` with 23 tests: 11 pairs × 2 themes, plus a check of the contrast function.
- E2E (fresh build): `114 passed (3.0m)`. Axe runs on the landing page (light and dark), `/dev/ui`, account, organisation, campaign and admin pages.
  - The first full run had 1 failure: the transient `document-title` on the campaign review page. It was fixed by the settle wait (see deviations).
- Deliberate breaks:
  - **`warning-700` light set to `#b8860b`:** `light: warning-700 on warning-50` failed with `2.90:1: expected 2.898840432178291 to be greater than or equal to 4.5`, giving `Tests 1 failed | 22 passed (23)`. Restored: `23 passed`.
  - **Real failure found while building:** dark `accent-text` on `surface-raised` = `3.05:1`, which led to `wayfinding-text`.
- Screenshots (Playwright, local production build, `docs/tasks/screenshots/TASK-032/`). Fonts are mocked in the sandbox, so headings render in a fallback serif in both sets; compare colour and layout.
  - `before|after-landing-1440-light.jpg`
  - `before|after-landing-1440-dark.jpg`
  - `before|after-landing-390-light.jpg`
  - `before|after-devui-1440-light.jpg`
  - `before|after-devui-1440-dark.jpg`
- `docker build`: not run locally (CI builds the images).

## Open questions / risks
- In `/dev/ui` the sample CampaignCard shows a second small cherry box over the LIVE chip. It is already in the "before" screenshot, so it was not introduced here; to look at separately.
- David updates the external design-system artifact from `packages/ui/design-system/README.md`.
- The CTO's project documents still say TASK-029 / ADR-039 for this task; they should be renamed to TASK-032 / ADR-041.

## Suggested commit message
feat(ui): design system v1.1 — cherry wayfinding, section bands, status colours (TASK-032, ADR-041)

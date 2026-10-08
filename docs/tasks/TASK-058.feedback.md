# TASK-058 feedback — account side menu and compact share box
Status: DONE (Built; PR pending)
Prompt: David 2026-10-08 with two screenshots of dev — "da ko si v nadzorni plošči imaš menu nekje ob strani … ta del share this campaign mi grafično ni všeč, vse je tk dolgočasno, enobarvno, mrtvo in preveč prostora zasede, razmisli o boljšem UX/UI".

## What I implemented
- **Account frame** `app/[locale]/account/layout.tsx` + `components/account/AccountNav.tsx`: name/short address, level chip (→ My impact), menu with the current page marked, votes-waiting count on My donations, Admin for platform admins, Log out. Desktop: sticky side column; ≤ 1024 px: a sideways-scrolling tab row under the header, current tab scrolled into view. All account pages lost their own `ch-container`/`max-w-*` wrappers (the frame sets the width). `/en/account` lost three link-only panels (organisation, email settings, my impact) that the menu replaces.
- **Share box** `CampaignShare.tsx`: "+20 points" strip for signed-in users (the number comes from `POINTS.referralDonor`), link cut at the start (personal code visible) joined to an accent **Copy** button, one row of six network icons (+ "More ways to share" where the browser offers a share sheet). Height ~330 → ~200 px at 1440. Icons: Simple Icons paths (CC0) in `share-icons.ts`, recorded in `THIRD_PARTY_NOTICES.md`.
- **Fix found on the way:** the delete-account panel used Tailwind `red-*` classes (not tokens; 2.5:1 contrast on dark). Now tokens (`--accent`, `--wayfinding-text`). `check:design` got a rule against Tailwind palette colour classes.

## Deviations
- The header's account dropdown stays (it is how you reach the area from public pages); the admin area keeps its own navigation.
- Network icons are monochrome (ink, inverted on hover) — brand colours would be new colours outside the design tokens (manifest §4). If David wants brand colours, they need tokens first.
- Logged out, account pages still redirect home themselves; the layout renders the page bare.

## Test results
Vitest (web): `Test Files 64 passed (64)`, `Tests 545 passed (545)`. Typecheck, lint: no errors. `check:design`: passed.

Design-guard break: the old `AccountClient.tsx` put back →
```
FAIL [Tailwind palette colour class (use a token: text-[var(--…)])] apps/web/src/app/[locale]/account/AccountClient.tsx:332: <h2 className="text-xl font-display uppercase text-red-600">
5 design violation(s) found.
```
restored → "Design check passed — no violations found."

E2E new `account-nav.spec.ts` (light + dark, 1440 + 390: the menu marks the current page on five account pages, level chip links to My impact, axe WCAG 2.1 AA clean, no horizontal page scroll; share box: "+20 points", link ends in `?ref=<8>`, Copy button, six network links in one row, axe clean). A first version asserted a pixel height (< 260 px); it failed in CI at 390 px (277 px — other fonts there), so it now checks the single icon row instead and the note text is shorter. The first dark run failed on the delete-account contrast (2.5:1, then 3.05:1 with `--accent-text`), fixed with `--wayfinding-text`. With `campaign-share`, `impact` (updated for the menu), `auth-nav`:
```
  38 passed (1.3m)
```
Full E2E suite before the last share-box tweak: `199 passed (8.8m)`, 1 flaky (`admin-demo.spec.ts`, passed on retry; unrelated). Screenshots light/dark × 1440/390 checked by eye (not committed).

## Open questions / risks
- None blocking. Possible next: brand colours on share icons (needs tokens), admin area in the same frame.

## Suggested commit message
feat(web): account side menu and compact share box (TASK-058)

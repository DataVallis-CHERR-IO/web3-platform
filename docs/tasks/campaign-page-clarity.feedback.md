# Campaign page clarity (agents' observations) — feedback
Status: DONE (Built; Live after merge + Deploy)

Source: crew run 46001735269 (2026-11-27), awkward-1's observations:
1. "Preparing your wallet…" is shown with no explanation of what it means or when it finishes.
2. "0% raised" next to "Succeeds at 10%" and "Ends today" leaves unclear what happens if the campaign misses 10 %.
3. It isn't clear whether payout happens in one go or in three steps — the story mentions three payments, the protection section says it is decided when the campaign ends.

## What I implemented
- (1) `campaignPage.donate.preparing`: "Preparing your wallet… This takes a few seconds; the Donate button appears when it is ready." Same idea for `emergencyPool.give.preparing` ("… the Give button appears …") and `emergencyPool.vote.preparing` ("… voting opens here …"). The wait is at most 8 s (`SMART_ACCOUNT_WAIT_MS`).
- (2) New `campaignPage.successLineDetail` "Succeeds at 10% · below that at the deadline, every donor can get their money back" on the campaign page's progress (the same promise the link preview already makes, `og.successLine`). Cards and the home page keep the short "Succeeds at 10%" (narrow 12 px meta row).
- (3) Not changed: the page already explains it ("Paid in one go or in three steps — How {org} is paid is set when the campaign ends …"); the "three payments" came from the agent-written story, not from the app.

## Files changed
- `apps/web/messages/en.json` — texts above.
- `apps/web/src/app/[locale]/campaigns/[slug]/page.tsx` — `successLineDetail` on the page's progress.
- `apps/web/e2e/campaign-pages.spec.ts` — new test "below the threshold the page says what happens to donors' money" (live campaign with 0 raised: progress 0, the new line visible).
- `docs/technical/04-web-app-and-auth.md` — §4 campaign page row and the donate-panel paragraph.

## Test results (this sandbox)
- `pnpm --filter web test`: `Tests  650 passed (650)`; lint, typecheck, `pnpm check:design` ("Design check passed — no violations found.") clean.
- `CI=1 pnpm exec playwright test e2e/campaign-pages.spec.ts --retries=0`: `4 passed (14.2s)` (both tests × chromium-1440 / chromium-390).
- Deliberate break — page back on `t("successLine")`, rebuilt: `✘ … below the threshold the page says what happens to donors' money` · `Locator: getByText('Succeeds at 10% · below that at the deadline, every donor can get their money back')` · `element(s) not found` · `1 failed`; restored.
- Screenshots 1440 and 390 (local build, mocked fonts): the line wraps under "0% raised · No donors yet · 11 days left" in the panel at 1440 and fits in two lines at 390; nothing overflows.

## Open questions / risks
- The "Preparing" text is only seen while Privy creates the smart account; not proven with a real Privy app (E2E has none) — the next crew run's awkward-1 observation will show it.

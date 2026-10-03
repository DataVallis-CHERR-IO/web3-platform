# Campaign panel — raised amount shown once (feedback)
Status: DONE

Ad-hoc fix from HANDOFF "Possible polish". David chose **option A** (2026-10-03): keep the cherry key figure, drop the second raised figure under the bar.

## What I implemented
- `Progress` (`packages/ui`) gets `showFigures?: boolean` (default `true`, so every other use is unchanged). `false` hides the raised/target figures row; the bar, the 10 % tick and the meta line stay.
- Campaign page panel (`/en/campaigns/[slug]`): `showFigures={false}`. The panel now reads: key figure (raised) → "raised of the €X target" → bar → "N% raised · donors · days left". Before, both the raised amount and the target appeared twice.
- New message `campaignPage.percentRaised` ("{percent}% raised").
- The campaigns list cards are unchanged (they have no key figure, so their figures row is the only one).

## Files changed
- `packages/ui/src/components/Progress.tsx` — `showFigures` prop.
- `apps/web/src/app/[locale]/campaigns/[slug]/page.tsx` — panel uses it; percent in meta.
- `apps/web/messages/en.json` — `percentRaised`.
- `apps/web/src/__tests__/progress-figures.test.tsx` — new unit tests (default shows row; `false` hides it, keeps bar + meta).
- `apps/web/e2e/campaign-pages.spec.ts` — panel has one key figure, no figures row, meta "N% raised".
- `docs/technical/04-web-app-and-auth.md` — campaign page row and Progress props.

## Deviations
- none

## New dependencies
- none

## Test results (this session, 2026-10-03)
```
$ pnpm exec vitest run src/__tests__/progress-figures.test.tsx
 Test Files  1 passed (1)
      Tests  2 passed (2)
```
Deliberate break — `{(showFigures || true) && (` in Progress.tsx:
```
   × Progress figures row > hides the figures row with showFigures={false} but keeps the bar and meta 12ms
AssertionError: expected <div class="ch-progress-figures">…(2)</div> to be null
      Tests  1 failed | 1 passed (2)
```
Restored → `Tests  2 passed (2)`.

```
$ pnpm --filter='!@cherrio/contracts' lint        → apps/web lint: Done
$ pnpm --filter='!@cherrio/contracts' typecheck   → apps/web typecheck: Done
$ pnpm check:design                               → Design check passed — no violations found.
$ pnpm build                                      → ok
$ CI=1 pnpm exec playwright test e2e/campaign-pages.spec.ts e2e/donate.spec.ts --retries=0
  6 passed (23.1s)
```

## Also fixed: flaky `organizations-api.test.ts:260`
CI on this PR failed with the known flake (`expected 6 to be 5`, HANDOFF open item): the test counted **all** organisations before/after, and another test file creates organisations in parallel. It now counts only the organisations with this test's three registry ids (and asserts there are 3 before).

Proof the parallel insert no longer matters — temporarily added `await createImportedOrg()` right after `before` was taken:
```
$ pnpm exec vitest run src/__tests__/organizations-api.test.ts -t "already claimed"
      Tests  1 passed | 8 skipped (9)
```
Reverted; full file: `Tests  9 passed (9)`.

## Suggested commit message
fix(web): campaign panel shows the raised amount once

# TASK-050 feedback — Terms and Privacy links at sign-in
Status: DONE (code + tests); the visible line in the Privy window needs a look on dev by David — E2E has no Privy app.

Spec: `docs/tasks/TASK-050-terms-at-sign-in.md`. Decision: David 2026-10-05; ADR-054 (Terms/Privacy drafts).

## What I implemented
- `apps/web/src/lib/auth/legal-links.ts` — `privyLegalConfig(origin, locale)` → `{ termsAndConditionsUrl: "<origin>/<locale>/terms", privacyPolicyUrl: "<origin>/<locale>/privacy" }`.
- `PrivyClientProvider` takes a `locale` prop (default `en`) and passes `legal: privyLegalConfig(window.location.origin, locale)` to `PrivyProvider`. Privy (`@privy-io/react-auth` 3.46.0, type `legal` in `types-*.d.ts`: "Rendered as a link in the privy modal footer. This overrides the server setting") shows both links in the sign-in window's footer.
- `app/[locale]/layout.tsx` passes the page locale.

## Files changed
- `apps/web/src/lib/auth/legal-links.ts` — new helper.
- `apps/web/src/components/auth/PrivyClientProvider.tsx` — `locale` prop, `legal` config, `browserOrigin()` shared with `browserRpcUrl()`.
- `apps/web/src/app/[locale]/layout.tsx` — passes `locale`.
- `apps/web/src/__tests__/privy-legal.test.tsx` — new (4 tests).
- Docs: this file, the spec, `docs/tasks/README.md`, `docs/technical/04-web-app-and-auth.md` §5.1, `docs/technical/09-status-and-roadmap.md`, `docs/guides/donors.md`, `docs/guides/fundraisers.md`.

## Deviations from the task (and why)
- The footer sentence is Privy's own English text, not a next-intl message (the manifest wants all UI text through next-intl). Privy offers no way to replace it; the platform is English-only at launch. Our own line under the header button was left out on purpose — the user signs in inside the Privy window, so that is where the notice belongs, and a second copy would only repeat it.
- No record of the accepted `LEGAL_VERSION` per user (left out on purpose — "ne več dela kot koristi"; add a column + audit only if the legal review asks for proof of acceptance).

## New dependencies
- none

## How to verify
1. `pnpm --filter web exec vitest run src/__tests__/privy-legal.test.tsx` → 4 passed.
2. On dev after the deploy: https://dev.cherr.io/en → "Log in" → the Privy window's footer shows links "Terms" and "Privacy Policy"; they open https://dev.cherr.io/en/terms and https://dev.cherr.io/en/privacy.

## Test results
New test file:
```
 ✓ src/__tests__/privy-legal.test.tsx (4 tests) 35ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
```

Deliberate break — the `legal:` line in `PrivyClientProvider.tsx` commented out:
```
   ✓ privyLegalConfig > builds absolute Terms and Privacy links for the locale 3ms
   ✓ privyLegalConfig > drops a trailing slash on the origin 1ms
   × PrivyClientProvider legal links > passes the page's Terms and Privacy links to the Privy sign-in window 40ms
     → expected undefined to deeply equal { …(2) }
   × PrivyClientProvider legal links > defaults to the English pages when no locale is given 10ms
     → expected undefined to match object { …(1) }
```
Restored with the reverse `sed`; the test passes again.

Full checks (this session):
```
pnpm --filter web lint        → eslint . (no output = clean)
pnpm --filter web typecheck   → tsc --noEmit (clean)
pnpm check:design (apps/web)  → Design check passed — no violations found.
pnpm --filter web test        → Test Files  58 passed (58) / Tests  507 passed (507)   (503 before + 4 new)
```

## Open questions / risks
- The exact footer wording is Privy's; if the legal review wants a different sentence (e.g. "By continuing…"), it would need our own notice outside the Privy window.

## Suggested commit message
feat(web): link Terms and Privacy in the Privy sign-in window (TASK-050)

# Fix feedback — zero amounts and the "How it works" header link
Status: DONE (Built, PR pending)

Reported by David on dev 2026-10-09 (Emergency Pool page text): every empty sub-pool read "≈ 0.00 POL (0.00 USDC)", and the header's "How it works" pointed to `/en/emergency-pool#how-it-works`, a section that only exists on the landing page.

## What changed
- `components/Amount.tsx` — `UsdcAmount` shows a zero as "0 USDC" (no converted value, no "≈"). Applies everywhere `UsdcAmount` is used (pool cards, campaign figures). Non-zero amounts unchanged.
- `components/AppHeader.tsx` — the link is `/#how-it-works` (rendered `/en#how-it-works`); the "current page" mark skips any link with `#`.
- `e2e/emergency-pool.spec.ts` — an empty sub-pool in POL display currency reads "Available now0 USDC" without "≈" while a non-zero pool still shows "POL (9.00 USDC)"; the header link's target is `/en#how-it-works` and the landing section is visible there (read from the attribute, because on phones the link is in the closed menu).
- Docs: `docs/technical/04-web-app-and-auth.md` (Amounts row, `/en/how-it-works` row).

## Test results
E2E `emergency-pool`, `campaign-card-layout`, `display-currency`, `auth-nav`, `landing`: `26 passed (1.1m)`.
Deliberate break — the zero guard disabled (`usdc === -1n`):
```
    Expected substring: "Available now0 USDC"
    Received string:    "Pool 10084468Available now≈ 0.00 POL (0.00 USDC)Given with a vote≈ 0.00 POL (0.00 USDC)Contributors0"
  1 failed
```
Restored. `pnpm --filter web test`: `Tests  592 passed (592)`; typecheck, lint clean; `check:design` passed.

## Suggested commit message
fix(web): show zero USDC without a converted value; header "How it works" works from every page

# TASK-039a feedback
Status: DONE (Built; Live on dev after merge + deploy)

## Why
David on dev (2026-10-05 07:52): publishing a demo campaign showed "You cannot publish a campaign of an organisation you belong to." TASK-038a made the acting admin the starter of every demo campaign and an ORG_ADMIN of "CHERR.IO Demo", so the four-eyes rule refused every publish (my 038a tests never prepared a publish). David chose a production-like flow over an exemption (ADR-053); a dev-only server operator key was considered and rejected by David — publishing stays in MetaMask.

## What I implemented
- **ADR-053**, spec `TASK-039-demo-production-flow.md` (039a; 039b "Act as" + "Fill with AI" next).
- Migration `0011`: `users.is_demo`, `organizations.is_demo`.
- `lib/demo/orgs.ts`: 18 invented organisations (SI, HR, AT, BA, RS, DE, KE, GR, MK; 2–3 causes each).
- `lib/demo/create.ts` rewritten: request `{ newOrganizations 0–5, campaignsPerOrganization 1–5, state APPROVED | PENDING_REVIEW, payoutAddress, durationMode }`, ≤ 10 campaigns per batch (`batch_too_large`); each new organisation gets a synthetic member (ORG_ADMIN, no Privy DID), an APPROVED KYB submission (submitted by the member, reviewed by the admin) and the admin's test wallet as payout address; with 0 new organisations, existing demo organisations with free places (max 5 active campaigns each; `no_demo_organizations`). Campaigns from the pool, the organisation's causes first (`pickSeedIndexes`), **started by the member**; APPROVED with ECB snapshot or PENDING_REVIEW without. Repair of the ADR-052 "CHERR.IO Demo" organisation (demo flag, own member, admin membership removed, starter reassigned). No exemption from the four-eyes rule anywhere.
- API: 409 for `batch_too_large` / `no_demo_organizations`, 503 only for the ECB rate.
- Admin → Demo: new form (organisations, per organisation, state, payout, duration; batch total shown and checked), list with organisation column and "In review — open to approve".
- Test helper `__tests__/helpers/demo.ts` (`deleteDemoOrganizations`).

## Deviations from the task (and why)
- none.

## How to verify (on dev after deploy)
1. https://dev.cherr.io/en/admin/demo → "Create demo organisations and campaigns": 2 organisations × 2 campaigns, "Approved — ready to publish", your test wallet → "Create" → "4 demo campaigns created and approved. Publish them below."; the list shows two new organisations (e.g. "Shelter Paws Pohorje").
2. "Publish all 4 demo campaigns" with MetaMask 0x4326…B5a7 → no "You cannot publish a campaign of an organisation you belong to"; MetaMask asks to confirm each.
3. The campaigns already created under "CHERR.IO Demo" are repaired on the next "Create": they can then be published too.
4. "In review" variant: the campaigns appear in https://dev.cherr.io/en/admin/campaigns → approve as usual.

## Test results (real outputs, 2026-10-05, sandbox)
- `vitest run demo-campaigns + demo-covers` → `Tests  19 passed (19)` (12 + 7).
- Deliberate break 1 (campaigns started by the admin — David's bug): `× … creates demo organisations whose own member starts the campaigns; the admin can publish them (four eyes intact) → expected '01a10aad-4178-…' to be '01a10aad-4198-…'` and `× … can send campaigns to review instead; the admin approves them like real ones → self_review` (`2 failed | 10 passed`).
- Deliberate break 2 (repair keeps the admin as member): `× … repairs the ADR-052 “CHERR.IO Demo” organisation … → expected [ { …(2) }, { …(2) } ] to have a length of 1 but got 2`. Both restored → `Tests  12 passed (12)`.
- `pnpm --filter web test` → `Test Files  51 passed (51)`, `Tests  456 passed (456)`; `pnpm --filter='!@cherrio/contracts' typecheck` → 0 errors; lint clean; `pnpm check:design` → passed.
- `pnpm --filter @cherrio/db test:integration` → `Tests  16 passed (16)`; `pnpm --filter worker test` → `Tests  6 passed (6)`.
- `pnpm build` → exit 0; Playwright `admin-demo` + `landing` + `campaign-review` → `10 passed (27.0s)`.

## Docs updated
ADR-053; technical 03 (`is_demo` on users/organisations), 04 (page, API), 09; owner guide v1.5 + change log + PDF; tasks README.

## Open questions / risks
- Demo organisations appear wherever approved organisations are listed (they carry `is_demo`; a "Demo" tag on organisation pages can follow in 039b).
- Synthetic members cannot log in until 039b ("Act as").

## Suggested commit message
feat(web,db): demo organisations in the production flow (TASK-039a, ADR-053)

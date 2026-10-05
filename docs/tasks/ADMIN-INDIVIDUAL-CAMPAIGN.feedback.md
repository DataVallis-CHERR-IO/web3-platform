# Fix — admin campaign list/page for individual campaigns — feedback
Status: DONE

## What I implemented
- `lib/admin/campaigns.ts` `listCampaigns` and `/en/admin/campaigns/[id]` used `innerJoin(organizations)`: a campaign for an individual (`org_id` null, `beneficiary_type` INDIVIDUAL) was missing from every admin tab and its page answered **404**. Both now use `leftJoin`; the organisation cell / line shows "Individual (Cherrion) — no organisation" (`admin.campaigns.individual`), the payout fallback reads `organization?.payoutAddress`.
- No code path creates such campaigns yet (individual KYC is not built); this is preventive, found in the HANDOFF open list (TASK-033d known limitation).

## Files changed
- `apps/web/src/lib/admin/campaigns.ts`, `apps/web/src/app/[locale]/admin/campaigns/page.tsx`, `apps/web/src/app/[locale]/admin/campaigns/[id]/page.tsx` — left join + label.
- `apps/web/messages/en.json` — `admin.campaigns.individual`.
- `apps/web/src/__tests__/admin-overview.test.ts` — new test (review + all views list the campaign with `organization` null).
- `apps/web/e2e/admin-overview.spec.ts`, `apps/web/e2e/helpers/session.ts` — new E2E (list row label, page opens, axe); helper accepts `orgId: null`.
- `docs/technical/04-web-app-and-auth.md` — route row.

## Deviations
- none

## Test results (real, 2026-10-05 sandbox)
- `vitest run src/__tests__/admin-overview.test.ts` → `Tests  6 passed (6)`.
- Deliberate break 1: `listCampaigns` back to `innerJoin` → `× … a campaign for an individual (org_id null) is listed without an organisation` / `AssertionError: expected [] to deeply equal [ [ …(3) ] ]` / `Tests  1 failed | 5 passed (6)`; restored → `6 passed (6)`.
- `pnpm build` + `playwright test e2e/admin-overview.spec.ts --retries=0` → `6 passed (25.2s)`.
- Deliberate break 2: the page back to `innerJoin` (rebuilt) → the new E2E fails at `getByRole('heading', { name: 'Campaign: E2E individual campaign …' })` — `element(s) not found` (the page is the 404); restored.
- Full web suite / full E2E: left to CI.

## Suggested commit message
fix(admin): list and open campaigns without an organisation

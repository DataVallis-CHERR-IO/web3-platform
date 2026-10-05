# TASK-037 — Landing page on real campaigns

Source: HANDOFF "Next" (pre-MVP list: "switch the landing page from fixtures to real campaigns"); TASK-011 left it as a follow-up. Ad-hoc task started by the cloud session on David's "Začni dev" (2026-10-05).

## Scope
- Replace `apps/web/src/fixtures/landing.ts` with real published campaigns from `listPublicCampaigns` (TASK-011a read model: `app.*` + indexed `chain.*` views).
- Hero: the live campaign whose deadline comes first; cover, organisation, progress (same figures as the campaign list), "Donate to this campaign" → campaign page, proof link → campaign page `#proof`.
- Grid "Campaigns raising now": the next live campaigns, at most 4 (one row), same card as `/campaigns` (shared `PublicCampaignCard`); "See all campaigns" link.
- Empty states: no live campaign → hero says "The first campaigns open soon" + "Start a campaign"; grid text for none / none live / only the hero.
- Remove what pretended to work: the cause filter buttons and the sample Charity Market Cap ranking (an honest one-line note instead, until trust scores exist).
- The page renders per request (`force-dynamic`).

## Not in scope
Cause filters (need a filtered list query), Charity Market Cap data (TASK-015/016), demo campaigns for testing (separate task, David 2026-10-05).

## Tests
Unit tests for the selection (pure), one DB-backed test against Postgres, one E2E (real campaign on `/en`, link to its page, sample data gone). Deliberate break: counting "ending" as live.

# Fix — publish link refused after a second prepare (2026-10-30)
Status: DONE

## What happened (David on dev, 2026-10-30)
Demo campaigns stayed "Publishing…" for 15+ minutes; Admin showed "A campaign with this ID exists on Polygon but does not match the approved one" (`campaign.link_mismatch`). Cause: `preparePublish` stores a new deadline (now + duration) each time it runs. When the same campaign is prepared again after its first transaction was already sent ("Publish all" pressed again, or a retry), the database holds the newer deadline while the chain holds the first one, and `linkDeployedCampaign` compared the deadline to the second.

## Fix
- `deadlineFromEarlierPrepare(deadline, blockTime, durationDays)` in `apps/web/src/lib/campaigns/publish.ts`: the on-chain deadline is also accepted when `deadline − block_time` lies between `duration − 1 day` and `duration` (what a prepare up to a day before mining produces). Address (from the offchain id), beneficiary, beneficiary type and target must still match exactly. On linking, the chain's deadline is stored.
- Campaigns already marked as mismatched link on the next "Check status", admin campaign page load or "Publish all" (the audit row stays as history).
- Left out on purpose: not re-preparing while a sent transaction is pending (the retry path after a dropped transaction needs a fresh deadline).

## Tests (this session)
- `campaign-publish.test.ts`: `Tests  6 passed (6)` (+ "published, then prepared again …", + `deadlineFromEarlierPrepare` bounds; the existing "deadline: 1" mismatch case still refused).
- Deliberate break (`false && deadlineFromEarlierPrepare(…)`): `Tests  1 failed | 5 passed (6)` — `expected 'APPROVED' to be 'DEPLOYED'`. Restored.
- `pnpm --filter web test`: `Test Files  79 passed (79)`, `Tests  632 passed (632)`; typecheck, lint, `check:design` clean.

Docs: technical 01 §publish.

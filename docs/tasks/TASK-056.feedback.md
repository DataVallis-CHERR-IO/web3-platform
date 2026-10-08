# TASK-056 feedback — Proof of Charity v2
Spec: `docs/tasks/TASK-056-proof-of-charity-v2.md` (ADR-057).

## Part a — schema (PR #160) and worker awards (PR #161)
Status: DONE — Live on dev (PR #161 merged 2026-10-08, CI green incl. indexer scenario and both E2E shards; Deploy run 37729761330: web, indexer rebuild, worker health all green).

### What I implemented
- **Migration `0017`** (own PR first — expand rule): `point_reason` + `FIRST_DONATION`, `REFERRAL`, `CAMPAIGN_SUCCESS`; `users_created_at_idx`; the ADR-048 vote entries (200, `vote:%`) voided with reason "ADR-057 rescale: a vote is 30 points (rule_version 2)" and `user_levels` recomputed. Proven on a seeded user before the PR: balances 200/200 → 0/0, both rows voided.
- **`packages/shared/src/points.ts`**: `POINTS` (the ADR-057 table), `POINTS_RULE_VERSION = 2`, `isqrt`, `donationPoints(totalUnits)` (10 × √ whole USDC of the total, cap 100), `SUCCEEDED_CAMPAIGN_STATES`, `LEVELS` + `levelFor()` (points **and** condition, climbed in order) for part b.
- **`apps/worker/src/points.ts` `awardPoints`** (replaces `awardVotePoints`): registration 50, first donation 100, donation points as the increase of the per-campaign target, vote 30 (`vote2:` keys), donor via your link 20 (donation after the referral row; ≤ 10 per campaign and referrer; erased referrers get nothing), friend 100 + 50 bonus, supported campaign success 20 (full pass only). Own campaigns / own organisation earn nothing. One generic `insertAwards` (both buckets, anti-join, `on conflict do nothing`), then `user_levels` recomputed for touched users.
- **Watermarks** extended: vote block, donation block (new index `donation.blockIdx` in `ponder.schema.ts` → one indexer rebuild on deploy; same index on the fake table), users created since the last tick − 10 minutes; full pass at start and every 6 hours.
- Account → Email settings hint: "Registration, donations, votes and the people you bring earn points (a vote: 30)…".

### Deviations
- Ratings (20), individual KYC (100) and referred organisations (300) are in the table but not awarded: those features do not exist yet (TASK-057, Sumsub, org referral).
- Campaign success is credited by the 6-hourly full pass only: a state change carries no block number to watch. The cherrions guide says "within six hours".
- A new vote cast between migration `0017` and the new worker would still get 200 under an old `vote:` key from the old worker (minutes on dev, testnet only) — left as is.

### Test results
Shared (`packages/shared/test/points.test.ts`, 5 new):
```
      Tests  105 passed (105)
```
Worker (`apps/worker/test/worker.test.ts`, the old vote test replaced by 7 tests — one per rule, the cap and split gifts, own organisation, referral timing/cap/erased referrer, friend, success on the full pass, watermark + full pass):
```
      Tests  13 passed (13)
```
Deliberate breaks (each restored, then `Tests 13 passed (13)`):
1. No cap on donation points → `× points (ADR-057) > donation points: 10·√USDC … capped at 100; first donation 100 once` — `Tests 1 failed | 12 passed (13)`
2. Referral credited for a donation **before** the visit → `× points (ADR-057) > a donor through your link: 20 per new donor … only for a donation after the visit …` — `Tests 1 failed | 12 passed (13)`
3. Own organisation not excluded → `× points (ADR-057) > nothing for donations to your own campaign or your organisation's` — `Tests 1 failed | 12 passed (13)`

Speed (perf database: 10,000 campaigns, 50,000 users with linked addresses, 1,000,000 votes, 100,000 donations; local Postgres; scratch `tsx` script, not committed):
```
first full pass: 136375 ms {"registration":50001,"vote":1000050,"donation":100000,"firstDonation":50000,"referral":0,"friend":0,"success":10000}
full pass (steady): 12128, 11660, 11195 ms          (after ANALYZE; 132748 ms right after the 2 M inserts, stale statistics)
minute tick: 169, 178, 129, 115, 154 ms
```
Per step of a steady full pass: registration 570 ms, votes 6190 ms, donations 3065 ms, first donation 882 ms, referrals 173 ms, friends 339 ms, success 145 ms.

### Open questions / risks
- The first full pass after a big backfill writes millions of rows in one transaction (136 s at 1 M votes); on dev today it is a few hundred rows.

## Suggested commit message (part a)
feat(points): Proof of Charity v2 awards in the worker (TASK-056a)

## Part b — "My impact" and the level on the account page
Status: DONE (Built; PR pending)

### What I implemented
- **`apps/web/src/lib/points/impact.ts`**: `getImpact(db, userId, recentLimit = 10)` — one aggregate query over the user's non-voided ledger rows: Status/Reward balances, campaigns supported (distinct campaign of v2 `donation:<campaign>:…` keys), votes (v2), ratings, campaigns succeeded, people brought (distinct user of `link:` / `friend:` keys), active months (distinct calendar months with a Status entry); then `levelFor()` (shared), the next level and `missingFor()` (what is still missing, points first). Latest 10 Status entries with the campaign title/slug only for a DEPLOYED campaign.
- **Page `/[locale]/account/impact`**: level panel (eyebrow, "Level 2 · Giver", Status points, progress bar with `role=progressbar`, "To reach Level 3 · Guardian:" + steps), "What you did" (4 figures), "Latest points" (reason, date, +points; empty state links to campaigns), reward note ("Points are recognition — they are not money…"). Logged out → `/en`.
- **`/en/account`**: the level ("Level 2 · Giver" / "No level yet") above a "My impact" panel with "See my impact"; **account menu** item "My impact".
- Messages `impact.*`, `app.myImpact` (next-intl); CSS `.ch-impact-*`, `.ch-meter` (tokens only).
- `e2e/helpers/session.ts` `deleteTestUser` also removes the user's `points_ledger` and `user_levels` rows.

### Deviations
- The spec says the worker stores the level in `user_levels.level`. The level is **computed on read** from the ledger instead (one indexed aggregate per page view), so it is always exact and the rules live in one place (`@cherrio/shared/points`). `user_levels.level` stays at its default until something needs it stored (a public badge or the Market Cap) — then the worker can write `levelFor()` in the same recompute.
- Demotion after 3 idle months is left for later, as the spec says.
- The two section headings first used `heading-2`, a class that does not exist (seen in the screenshot: small body text). Switched to the app's common `text-xl font-display uppercase`. `campaigns/[slug]/page.tsx` and `licences/page.tsx` use the same missing class — not touched here.

### Test results
Vitest `src/__tests__/impact.test.ts` (3 new: new user; seeded ledger → 510 points, 3 campaigns, 1 vote, 2 people, 6 months, 1 success, Level 2, next Guardian, missing `[190 points, rating]`, recent 10 with the campaign title, voided entry excluded; `missingFor` for every level):
```
 ✓ src/__tests__/impact.test.ts (3 tests) 85ms
      Tests  3 passed (3)
```
Deliberate break — the `voided_at is null` filter removed from the aggregate:
```
   × My impact > counts campaigns, votes, people and months from the ledger; level and next step follow ADR-057 26ms
     → expected { statusPoints: 710, …(11) } to match object { statusPoints: 510, …(7) }
      Tests  1 failed | 2 passed (3)
```
restored → `Tests  3 passed (3)`.

Full web suite (after `.ch-impact-recent-what` was added to the shared CSS — the design-classes test had caught it as undefined):
```
 Test Files  63 passed (63)
      Tests  538 passed (538)
```
`pnpm --filter web typecheck` and `lint`: no errors. `check:design`: "Design check passed — no violations found."

E2E `e2e/impact.spec.ts` (new; signed out → home; new user → "No level yet", "earn 50 more points", empty state; seeded ledger → region "Level 2 · Giver", "350 status points", progressbar `aria-valuenow=350`, steps exactly ["earn 350 more points", "rate an organisation after a campaign"], figures ["3","0","1","1"], 7 latest entries with the vote first, reward note, axe WCAG 2.1 AA clean, then `/en/account` shows "Level 2 · Giver" and "See my impact" leads back) together with `a11y.spec.ts`, local production build:
```
  74 passed (1.8m)
```
Screenshots at 1440 and 390 checked by eye (Playwright output folder, not committed).

### Open questions / risks
- The aggregate reads all of one user's ledger rows on each view; both queries use `points_ledger_user_id_created_at_idx`. Not measured at scale (a very active user has hundreds of rows).

## Suggested commit message (part b)
feat(web): My impact page and level on the account page (TASK-056b)

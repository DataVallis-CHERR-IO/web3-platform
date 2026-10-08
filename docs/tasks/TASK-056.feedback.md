# TASK-056 feedback — Proof of Charity v2
Spec: `docs/tasks/TASK-056-proof-of-charity-v2.md` (ADR-057).

## Part a — schema (PR #160) and worker awards
Status: DONE (part a); part b (levels + "My impact") follows.

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

## Suggested commit message
feat(points): Proof of Charity v2 awards in the worker (TASK-056a)

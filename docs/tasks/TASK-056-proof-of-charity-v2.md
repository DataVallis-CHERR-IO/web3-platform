# TASK-056 — Proof of Charity v2 (ADR-057)

Owner decision: ADR-057 (David 2026-10-07: "ja, super si spisal"). Order agreed the same day: sharing (TASK-055, done) → **this** → ratings (TASK-057) → registry import (TASK-016) → Charity Market Cap (TASK-017).

## Goal
Points and levels that reward **taking part**, not the size of a single gift: diminishing returns for donations, a new kind of action for each level, credit for bringing people (TASK-055 attribution), visible impact.

## Parts (three PRs, expand rule from HANDOFF)
- **056a-schema** — migration only: `point_reason` gets `FIRST_DONATION`, `REFERRAL`, `CAMPAIGN_SUCCESS`; index `users_created_at_idx`; the old ADR-048 vote entries (200 each, `ref_key 'vote:%'`) are voided with reason "ADR-057 rescale" and the `user_levels` counters are recomputed. No code reads the new values yet.
- **056a** — worker awards (`apps/worker/src/points.ts` → `points/` module), all with `rule_version = 2`, both buckets (ADR-049):
  | Event | Points | `reason` / `ref_key` | Source |
  |---|---|---|---|
  | Registration | 50 | `REGISTRATION` / `registration` | `users` (not demo, not erased) |
  | First donation ever | 100 | `FIRST_DONATION` / `first-donation` | first `chain.donation` from any linked address |
  | Donation | `min(100, floor(10 × √(total USDC to that campaign)))`, credited as the increase | `DONATION` / `donation:<campaign>:<target>` | `chain.campaign_donor` totals of the user's addresses per campaign; none when the user is the starter or a member of the campaign's organisation |
  | Milestone vote | 30 | `VOTE` / `vote2:<campaign>:<round>` | `chain.vote` (watermark from #151) |
  | Donor via your link | 20, at most 10 per campaign per referrer | `REFERRAL` / `link:<campaign>:<donor user>` | `campaign_referrals` + a donation of that user to that campaign **after** the row's `created_at`; referrer not erased |
  | Friend joins through your link and donates | 100 to the referrer, 50 to the friend | `REFERRAL` / `friend:<friend user>` and `friend-bonus` | `users.referred_by_user_id` + the friend's first donation after `users.created_at` |
  | Supported campaign succeeds | 20 | `CAMPAIGN_SUCCESS` / `success:<campaign>` | campaigns in `SUCCEEDED`, `PAYING`, `VOTING`, `COMPLETED`, `NEEDS_REVIEW` (reached the threshold) |
  Ratings (20), individual KYC (100) and referred organisations (300) come with TASK-057 / Sumsub / org referral — not here.
  Donation points use the **total per campaign** (√ of the sum), so splitting a gift into many small ones earns nothing extra.
  Speed: per-minute ticks only look at new chain rows (block watermark; new index `donation.blockIdx`) and recently created users; a full pass at start and every 6 hours catches the rest (campaign success, late-linked addresses).
- **056b** — levels and "My impact": `lib/points/levels.ts` computes the level from Status points **and** conditions (L2: 3 campaigns supported; L3: ≥1 vote and ≥1 rating; L4: ≥3 people who donated through your link; L5: points in 6 different calendar months), the next step in words ("1 more vote to Guardian"), stored in `user_levels.level` by the worker; page `/[locale]/account/impact` (level, progress, next step, campaigns supported / succeeded, people brought, votes, recent points); level badge on the account page. Demotion after 3 idle months (with an email first) is **left for later** — nobody can be idle 3 months on the test network yet.

## Not in scope
Ratings (TASK-057), social points (Phase 2), points → CHR (Phase 2, legal opinion), a public leaderboard or supporter wall (later; needs opt-in).

## Tests (each part)
Worker tests against Postgres with the fake chain: every rule, idempotency (two ticks = same ledger), √ cap and split donations, own-organisation exclusion, referral timing (donation before the referral row earns nothing), self/erased referrer, watermark + full pass. Web tests for levels and the page (Vitest + E2E). Deliberate breaks in the feedback file.

## Docs
`01-PRODUCT-SPEC.md` §3 already updated (PR #155); `docs/technical/03` (ledger rules), `04` (impact page), `09`; `docs/guides/cherrions.md` (mark rules live as they ship).

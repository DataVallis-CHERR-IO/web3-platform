# TASK-033 — Voting, refunds, "My donations", notifications and triggers

Written by the cloud CTO session on 2026-10-04 from David's decisions of 2026-10-03/04 (ADR-045).
Depends on: TASK-011 (donations, smart accounts, `chain` views), TASK-003/004 (contracts), TASK-026 (indexer on dev).
Model: strong (money, on-chain transactions, votes, personal data in notifications).
Takes over the voting/refund/evidence part of the old backlog item TASK-013. TASK-014 (Emergency Pool pages) and TASK-015 (ratings, levels) stay separate.

David's reasoning (2026-10-03): card purchase (TASK-012) is only another way to fund a wallet. The flow **donation → payout → evidence → vote → next tranche or refund** must be complete with a crypto wallet alone, before card purchase.

## Parts

Each part is its own PR with a feedback file and a docs update.

| Part | Branch | Content | Feedback |
|---|---|---|---|
| 033a | `feat/TASK-033-adr-vote-params` | ADR-045; `PlatformConfig` defaults 7 days / 25 %; forge tests; spec, architecture, technical docs; whitepaper corrections log | `TASK-033a.feedback.md` |
| 033b | `feat/TASK-033b-donor-lifecycle` | Lifecycle read model; campaign page after the deadline (state, vote, refund, pool, trigger buttons); "My donations" in the account; in-app "votes waiting" badge | `TASK-033b.feedback.md` |
| 033c | `feat/TASK-033c-fundraiser-evidence` | Fundraiser dashboard per deployed campaign: finalize, release, evidence upload → bundle hash → `submitEvidence`, close vote; donors see the evidence on the campaign page | `TASK-033c.feedback.md` |
| 033d | `feat/TASK-033d-guardian` | Admin chain view: `setPayoutMode` (operator), `NEEDS_REVIEW` list with evidence + vote result → `resolve(approve/reject)`, `freeze` (Guardian); signed in the admin's browser (ADR-035) | `TASK-033d.feedback.md` |
| 033e | `feat/TASK-033e-notifications` | Worker `notify` queue + email provider; vote opened / 24 h reminder / refund available; email opt-in for wallet-only donors; unsubscribe; Proof of Charity points for votes (200) | `TASK-033e.feedback.md` |
| 033f | `feat/TASK-033f-fallback-triggers` | Manual fallback (ADR-050): `finalize` / `closeVote` after 7 idle days, `sweepUnclaimed` after the refund window, listed in Admin → Chain actions and signed by an admin wallet | `TASK-033f.feedback.md` |

## Rules (already decided)

- **ADR-045:** vote window **7 days**; quorum **25 %** of donated human weight (`totalRaised − poolDonated`); approval **≥ 51 %** of cast weight; no "silence = consent" — no quorum → `NEEDS_REVIEW` → Guardian.
- **ADR-008:** vote weight = USDC donated by **that address**. CHERR.IO wallets donate from their smart account (TASK-011c), so votes, refunds and pool settlements must be sent from the same smart account. A user with several addresses votes once per address.
- **Triggers (ADR-045 §4):** fundraiser → `finalize`, `release`, `submitEvidence`, `closeVote` (own POL gas; the beneficiary address is the only one allowed to call `submitEvidence`); donors → `vote`, `claimRefund`, `settleToPool` (sponsored for smart accounts); anyone logged in → `finalize`, `closeVote`, `release` when they are due; worker fallback only after 7 idle days.
- The web app reads on-chain state only from `chain.*` views (ADR-026); every transaction is signed in the user's browser (no server keys in the web app).
- Contract facts to respect (`docs/technical/02-smart-contracts.md`): `finalize` only `LIVE` and `now ≥ deadline`; `release` needs `payoutMode` set by the **operator** (033d) and, for `SINGLE`, `endTime + releaseDelay` (72 h); `submitEvidence` only `PAYING` and only the beneficiary; `vote` only `VOTING`, `now < voteEnd`, donors, once per round; `closeVote` only `now ≥ voteEnd`; `claimRefund` only `FAILED`/`REJECTED`, preference `REFUND`, not settled, not swept; `settleToPool(donor)` only preference `EMERGENCY_POOL`, callable by anyone for that donor.
- Human layer: plain words ("Approve the next payment", "Get your money back"); the proof layer links every action to its transaction.
- Money: USDC `bigint`, amounts on screen through `UsdcAmount` (display currency, ADR-040).

## 033a — decision and contract defaults (this PR)

- `PlatformConfig`: `voteWindow = 7 days`, `quorumBps = 2500`. Ranges and setters unchanged.
- Forge: defaults test, setter event tests, and quorum boundary tests (24.9 % → `NEEDS_REVIEW`, exactly 25 % → passes, no votes → `NEEDS_REVIEW`, snapshot values in a new campaign).
- Docs: ADR-045 (ADR-008 marked amended), Product Spec §2.4, Architecture §2.1, technical 01/02/09/10, `docs/whitepaper/CORRECTIONS.md`.
- **Amoy rollout (David):** the deployed Amoy `PlatformConfig` keeps 24 h / 50 % until the timelock runs `setVoteWindow(604800)` and `setQuorumBps(2500)`. Only campaigns created after that use the new values. Steps are in `TASK-033a.feedback.md`.

## 033b — donor side

1. **Read model** (`lib/campaigns/lifecycle.ts`): from `chain.campaign`, `chain.vote_round`, `chain.vote`, `chain.campaign_donor`, `chain.refund`: state (split `PAYING` from `SUCCEEDED`), deadline passed, `voteEnd`, round, yes/no weight, turnout vs. quorum and approval (using the campaign's snapshot values: read them from the indexer if indexed, otherwise from ADR-045 constants marked as such), tranches released, per-donor eligibility (`canVote`, `hasVoted`, `refundable` amount, `poolSettleable` amount, settled).
2. **Campaign page after LIVE:** a lifecycle panel replaces the donate panel:
   - `ending` (LIVE past deadline): "This campaign has ended. Finish it" → `finalize()`.
   - `voting`: evidence summary (033c), countdown, current turnout vs. 25 % and approval; donors with weight see "Approve" / "Reject"; after `voteEnd` anyone sees "Count the votes" → `closeVote()`.
   - `failed` / `rejected`: "Get your money back" (`claimRefund`) or "Send to the Emergency Pool" (`settleToPool`) according to the donor's preference, with the exact amount (pro-rata after rejection).
   - `needs-review`: "CHERR.IO is reviewing this vote" (Guardian).
3. **Client helpers** (`lib/campaigns/lifecycle-client.ts`, the `changePreference` pattern from `donate-client.ts`): `vote`, `claimRefund`, `settleToPool`, `finalize`, `closeVote`, `release` — smart account → one sponsored `sendCalls`, external wallet → `writeContract` with `polygonFees`; contract errors mapped to fixable messages.
4. **"My donations"** (`/[locale]/account/donations`): every campaign donated to from any of the user's `user_addresses`, amount, state, the next action with the same buttons; `GET /api/me/donations`.
5. **Badge:** header/account shows "N votes waiting" for open rounds where one of the user's addresses has weight and has not voted.
6. Tests: unit (read model with `fake-chain`), API, E2E with the fake wallet for vote and refund.

## 033c — fundraiser side

- Dashboard per deployed campaign (`/account/campaigns/[id]`): on-chain state and the next due action: finalize, release, upload evidence, close vote.
- Evidence: files → private storage (encrypted, ADR-033), optional public files; a manifest (file SHA-256 list, round, note) → SHA-256 = `bundleHash`; `evidence_bundles` row (exists, unused today); `submitEvidence(bundleHash)` signed by the beneficiary wallet.
- Campaign page shows the evidence of each round (public summary and public files; private files: organisation admins and platform admins only — **decided 2026-10-04, ADR-047**).

## 033d — admin / Guardian

- Admin campaign view reads chain state.
- `setPayoutMode` (operator role) after success: suggestion from the rules (individual → MILESTONES; org rating ≥ 4.0 → SINGLE; first campaign → SINGLE supervised).
- `NEEDS_REVIEW` list: evidence, vote result, turnout → `resolve(true|false)` with a required note in `audit_log`; `freeze` with a reason.

## 033e — notifications and points

- `app.notifications` (outbox) + `app.notification_preferences`/unsubscribe token; worker `notify` queue; an email provider (**open decision**).
- Events: vote opened (EvidenceSubmitted), reminder 24 h before `voteEnd`, refund/pool settlement available (Finalized FAILED, REJECTED), vote result.
- Wallet-only donors: "Leave an email for vote notifications" after donating and on "My donations" (double opt-in).
- Points: `points_ledger` row `VOTE`, 200, once per (campaign, round, user), from the indexed `Voted` event.

## 033f — fallback triggers

- **Decided 2026-10-04 (David: "ročno"), ADR-050:** no relayer key on the server for the testnet MVP. The rules stay — `LIVE` past deadline + 7 days → `finalize`; `VOTING` past `voteEnd` + 7 days → `closeVote`; `FAILED`/`REJECTED`, not swept, past `settlementStart + snap_refund_sweep_delay` → `sweepUnclaimed` — but the web app only **lists** them in Admin → Chain actions (`lib/admin/guardian.ts` `dueFallbacks`, `loadGuardianQueue`), and an admin sends the call from their own wallet on the admin campaign page ("CHERR.IO steps in"). All three are callable by anyone: no role needed. Intent and transaction go to `audit_log` like 033d.
- Rides along: Account → Email settings shows "Change address" once a contact address is confirmed; the confirmed address again → `same_as_contact` (no new link).

## Open decisions (ask David when the part starts)

1. **Amoy test window:** on Amoy a 7-day vote makes end-to-end tests on dev slow. Option: set Amoy's window to 1 h for testing and keep 7 days for uat/prod. (033a feedback; David decides.)
2. **Email provider** for 033e (e.g. Resend, Postmark, Amazon SES) — David opens the account and stores the key.
3. **Donor access to private evidence** (Architecture §5): only a public summary, or private files viewable by logged-in donors of that campaign.
4. ~~**Relayer key** for 033f on the server (or keep fallback manual for the testnet MVP).~~ Decided: manual (ADR-050); revisit before mainnet.

## Must not touch

- Contract logic other than the two defaults (033a). No new contract functions in this task.
- Deploy scripts that broadcast (`forge script --broadcast`), the timelock, the Safe.

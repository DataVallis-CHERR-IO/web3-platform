# TASK-003 — Contracts: milestones, donor voting, Guardian freeze/resolve

Read first: `docs/01-PRODUCT-SPEC.md` §2.4, §2.6, `docs/02-ARCHITECTURE.md` §2.3, ADR-008, and the TASK-002 feedback.

## Goal
Implement the MILESTONES payout path and bounded Guardian powers in `Campaign.sol`.

## Scope
1. **Tranches**: in MILESTONES mode, net amount `net = totalRaised − fee` split into 3 tranches: `t1 = net / 3`, `t2 = net / 3`, `t3 = net − t1 − t2` (remainder goes to last). Fee sent to treasury with T1.
2. `release()` in MILESTONES: first call releases T1 (state → `MILESTONE_1_RELEASED` — add states `M1_RELEASED`, `M2_RELEASED` if cleaner; document the final enum in feedback).
3. `submitEvidence(bytes32 bundleHash)` — beneficiary only, after T1 or T2 released; opens voting round `n` with `voteEnd = now + voteWindow` (snapshotted). Emits `EvidenceSubmitted(round, bundleHash, voteEnd)`. State `VOTING`.
4. `vote(bool approve)` — only donors with `donated > 0`, once per round, before `voteEnd`. Weight = `donated[voter]`. Emits `Voted(round, voter, approve, weight)`.
5. `closeVote()` — anyone after `voteEnd`:
   - turnout = `(yes + no) * 10000 / totalRaised`
   - if turnout < `quorumBps` → `NEEDS_REVIEW`
   - else if `yes * 10000 ≥ (yes + no) * approvalBps` → release next tranche (T2 or T3); after T3 → `COMPLETED`
   - else → `REJECTED`
   - Emit `VoteClosed(round, yes, no, outcome)`.
6. **Rejected remainder**: remaining unreleased amount distributed to donors **pro-rata** by `donated`: `share = remaining * donated[d] / totalRaised` (handle rounding dust → pool). Donors with REFUND preference `claimRefund()`; EMERGENCY_POOL via `settleToPool()`. Reuse TASK-002 functions generalized to "refundable amount per donor".
7. **Guardian** (`GUARDIAN_ROLE` from PlatformConfig):
   - `freeze()` — any state before `COMPLETED`/`FAILED`; remembers previous state; blocks `release`, `submitEvidence`, `vote`, `closeVote`.
   - `resolve(bool approve)` — only in `NEEDS_REVIEW` or `FROZEN`: approve → continue (release next tranche, or restore previous state if frozen before a release was due); reject → `REJECTED` path.
   - Guardian can never choose a recipient.
8. SINGLE mode with no prior rating (first campaign): Guardian may `freeze()` between `SUCCEEDED` and `release()`. Add optional `releaseDelay` (default 72h, config snapshot) for SINGLE payouts so Guardian has a review window. Document.

## Tests
- Full-path tests: SINGLE; MILESTONES all approved; reject at round 1; reject at round 2; no quorum → Guardian approve; no quorum → Guardian reject; freeze in each state; late vote revert; double vote revert; non-donor vote revert.
- Fuzz: tranche math sums exactly to net; pro-rata remainder sums ≤ remaining with dust handled.
- Extend invariant: contract USDC balance equals owed amounts at every step.
- Coverage ≥ 95%.

## Must not touch
`docs/**`, `apps/**`, `PlatformConfig` public interface (you may add config fields `releaseDelay` with setter — list in feedback).

## Acceptance criteria
- All TASK-002 tests still pass.
- Voting math matches ADR-008 exactly (boundary tests at 50.00% turnout and 51.00% approval).
- Feedback includes a state diagram (mermaid) of the final implementation.

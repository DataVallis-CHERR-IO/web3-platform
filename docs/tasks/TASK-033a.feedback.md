# TASK-033a feedback — ADR-045 voting parameters and contract defaults
Status: DONE (source + docs). Amoy on-chain values: waiting for David's timelock calls (below).

## What I implemented
- **ADR-045** (David, 2026-10-03/04): vote window 7 days, quorum 25 % of donated human weight, approval unchanged at ≥ 51 % of cast weight, no "silence = consent", who triggers what, notifications, "My donations", incentives, Guardian view. ADR-008 is marked as amended.
- `PlatformConfig` defaults: `voteWindow` `24 hours` → `7 days`, `quorumBps` `5000` → `2500`. Setters and ranges unchanged. These values also drive Emergency Pool allocation votes (they read the same config).
- Forge tests updated and added (quorum boundaries at 25 %, no-votes case, campaign snapshot).
- Task spec `docs/tasks/TASK-033-voting-lifecycle.md` (parts a–f, open decisions).
- `docs/whitepaper/CORRECTIONS.md`: every whitepaper sentence that changes with ADR-045, with the replacement text, to be applied at the end of the phase (David: "zabeleži, ker bomo morali popravit whitepaper dokumentacijo na koncu").

## Files changed
- `packages/contracts/src/PlatformConfig.sol` — two defaults.
- `packages/contracts/test/PlatformConfig.t.sol` — defaults and setter-event expectations.
- `packages/contracts/test/Campaign.t.sol` — `test_closeVote_failsQuorum_needsReview` rewritten for 25 % (three donors 750/249/1, only the 249 donor votes = 24.9 %); new `test_closeVote_quorumExactly25Percent_passes`, `test_closeVote_noVotes_needsReview`, `test_snapshot_voteWindowAndQuorum_adr045`; comment in the pool-funded quorum test.
- `docs/03-DECISIONS.md` — ADR-045, ADR-008 amended.
- `docs/01-PRODUCT-SPEC.md` §2.4, `docs/02-ARCHITECTURE.md` §2.1 — new numbers.
- `docs/technical/01-system-overview.md`, `02-smart-contracts.md` (incl. "deployed values vs. source defaults"), `09-status-and-roadmap.md`, `10-investor-technical-faq.md` — new numbers, status, dates.
- `docs/tasks/README.md` — TASK-033 row; TASK-013 marked superseded.
- `docs/whitepaper/CORRECTIONS.md` (new), `docs/whitepaper/README.md` (points to it).

## Deviations from the task (and why)
- none. The whitepaper text itself is **not** changed yet, as David asked; the log holds the exact edits.

## New dependencies
- none

## How to verify
1. `cd packages/contracts && forge test --use <solc 0.8.24> --offline` → 254 passed, 0 failed.
2. `forge fmt --check` → no output.
3. CI "Contracts" job on the PR.

## Test results (real outputs, this session)
Before fixing the tests, with only the two defaults changed (proves the old tests pinned 24 h / 50 %):
```
Ran 9 test suites in 27.29s (45.25s CPU time): 247 tests passed, 4 failed, 0 skipped (251 total tests)
[FAIL: assertion failed: 3 != 6] test_closeVote_failsQuorum_needsReview() (gas: 412195)
[FAIL: assertion failed: 604800 != 86400] test_constructor_defaults() (gas: 12718)
[FAIL: log mismatch at param 0: expected=0x…1388, got=0x…09c4] test_setQuorumBps() (gas: 21329)
[FAIL: log mismatch at param 0: expected=0x…15180, got=0x…93a80] test_setVoteWindow_success() (gas: 21351)
```
After the test changes:
```
Ran 9 test suites in 27.77s (46.04s CPU time): 254 tests passed, 0 failed, 0 skipped (254 total tests)
```
Deliberate break — quorum default set to 2600 (26 %) instead of 2500:
```
[FAIL: assertion failed: 6 != 3] test_closeVote_quorumExactly25Percent_passes() (gas: 528380)
[FAIL: assertion failed: 2600 != 2500] test_snapshot_voteWindowAndQuorum_adr045() (gas: 14416)
[FAIL: assertion failed: 2600 != 2500] test_constructor_defaults() (gas: 13782)
[FAIL: log mismatch …] test_setQuorumBps() (gas: 21329)
Ran 2 test suites in 17.74ms (23.40ms CPU time): 150 tests passed, 4 failed, 0 skipped (154 total tests)
```
Restored to 2500:
```
Ran 2 test suites in 28.06ms (34.01ms CPU time): 154 tests passed, 0 failed, 0 skipped (154 total tests)
```

## Amoy rollout — David (not done by the session: needs the Safe key)
The deployed Amoy `PlatformConfig` (`0x4d2570ccB2a6653D62a002027C0d383FfB193A16`) still holds 24 h / 50 %. Its admin is the TimelockController `0x52ba2090E62c9155c04E7E5f28DB9Af00A6AAede` (5-minute delay); proposer and executor is the Safe (on Amoy the testnet EOA `0x4326…B5a7`, ADR-025). Only campaigns created **after** the calls use the new values.

**Wait for David's answer on the Amoy test window first** (open decision 1 in the spec): if Amoy should use a short window for testing, the first payload changes.

Calldata (computed with `cast calldata`):
- `setVoteWindow(604800)` (7 days) → `0x9e33a38e0000000000000000000000000000000000000000000000000000000000093a80`
- `setQuorumBps(2500)` → `0x0527aab600000000000000000000000000000000000000000000000000000000000009c4`

Steps (Polygonscan Amoy "Write Contract" on the timelock, MetaMask with the Safe EOA):
1. `scheduleBatch(targets=[0x4d25…3A16, 0x4d25…3A16], values=[0,0], payloads=[<setVoteWindow>, <setQuorumBps>], predecessor=0x00…00 (32 bytes), salt=0x00…01 (any unused 32 bytes), delay=300)`.
2. Wait at least 5 minutes.
3. `executeBatch(` the same targets, values, payloads, predecessor and salt `)`.
4. Check on the `PlatformConfig` "Read Contract" tab: `voteWindow` = 604800, `quorumBps` = 2500.

## Open questions / risks
- **Amoy test window** (David): 7 days makes end-to-end voting tests on dev slow. Option: Amoy `voteWindow = 1 hour` for testing, 7 days on uat/prod.
- **Lower quorum and large donors:** a single donor holding ≥ 25 % of the human weight now reaches quorum alone. Approval still needs ≥ 51 % of the cast weight, and the Guardian can freeze; the evidence is public. Pool-donated money is still excluded from the base, so heavily pool-funded campaigns need even fewer human votes (TASK-004 risk 2, unchanged).

## docs/technical chapters updated
01, 02, 09, 10.

## Suggested commit message
feat(contracts): 7-day vote window and 25 % quorum by default (ADR-045)

# TASK-034 — Contract admin console

Written by the cloud CTO session on 2026-10-04 from David's request (2026-10-04 09:10): *"rabimo nadzorno ploščo za upravljanje funkcij na smart contractu, se pravi admin contracta, da imamo lepo na cherrio, ko se prijavim z MetaMaskom kot admin, da lahko lepo spreminjam vrednosti, človeške številke, ne binarne"* — first use: set the Amoy vote window to 1 hour for testing (ADR-045, TASK-033 open decision 1).
Depends on: TASK-002/004 (PlatformConfig, TimelockController), TASK-025 (admin role), TASK-010 (operator wallet in the admin's browser, ADR-035), PR #66 (`/api/rpc`).
Model: strong (on-chain governance actions, money parameters).

## Goal

A platform admin opens **Admin → Contracts** on CHERR.IO, sees every `PlatformConfig` value in human units (percent, days/hours, USDC, addresses), changes one or more values in a form with human inputs, reviews "old → new", and signs the change with the wallet that holds the timelock's proposer role (on Amoy: David's MetaMask EOA = the "Safe", ADR-025). After the timelock delay the console shows the change as ready and the admin executes it with one click. Every change is recorded and audited.

## Parts

| Part | Branch | Content | Feedback |
|---|---|---|---|
| 034a | `feat/TASK-034a-contract-console` | Human-unit parameter library; timelock helpers (operation id, schedule/execute/cancel calls, Safe Transaction Builder JSON); `app.contract_changes` + admin API (record schedule/execute/cancel, list) with audit log | `TASK-034a.feedback.md` |
| 034b | `feat/TASK-034b-console-ui` | `/admin/contracts` page: current values, the connected wallet's roles, timelock delay; change form → review → schedule; pending changes with countdown → execute / cancel; admin home link; **owner guide PDF** | `TASK-034b.feedback.md` |

Guardian and operator actions on a single campaign (`freeze`, `resolve`, `setPayoutMode`) are direct calls (no timelock) and stay in TASK-033d; they reuse 034's wallet/role helpers.

## Decision added with this spec

ADR-046 (see `docs/03-DECISIONS.md`).

## Rules

- **Only through the timelock.** `PlatformConfig` setters are `DEFAULT_ADMIN_ROLE`, held by the TimelockController; the console never calls a setter directly. It sends `scheduleBatch(targets, values = 0, payloads, predecessor = 0, salt = random, delay = getMinDelay())` and later `executeBatch(...)` with the same arguments. `cancel(id)` for a scheduled change (canceller role).
- **Signed in the admin's browser** with a connected external wallet (Privy, like publishing, ADR-035). No key on the server.
- **Reads** go through the browser: the connected wallet's provider, or the same-origin read-only `/api/rpc` proxy when no wallet is connected. The server never reads the chain (ADR-026).
- **Human units, exact raw values.** Inputs and display in human units; the review table also shows the exact raw value that goes on-chain (`2500 bps`, `3600 s`, `1000000` USDC units). Conversions are exact (no floats): percent with at most two decimals ↔ basis points; durations as whole minutes/hours/days ↔ seconds; USDC with at most six decimals ↔ `bigint` units.
- **Bounds** are checked in the form with the contract's own limits (`MAX_FEE_BPS`, `MIN/MAX_VOTE_WINDOW`, `MAX_RELEASE_DELAY`, approval > 50 %, sweep 30–365 days, quorum/threshold 0.01–100 %, min donation > 0, non-zero addresses); the contract checks again on execution.
- **Clear consequence text:** a change applies only to campaigns (and pool allocations) **created after it is executed**; running campaigns keep their snapshot.
- **Multisig Safe (mainnet):** when no connected wallet holds the proposer role and the proposer is a contract, the console offers a Safe Transaction Builder JSON of the same `scheduleBatch` (and later `executeBatch`) instead of sending. (Full Safe proposal flow stays TASK-023.)
- **Record:** `app.contract_changes` stores the operation (id, chain, timelock, targets, payloads, salt, delay, human summary, who, schedule/execute/cancel transactions and times). The server recomputes the operation id from the stored arguments and accepts only the known `PlatformConfig` address as target and only known setter selectors as payloads. Every record/execute/cancel writes `audit_log`. The chain is the source of truth for the state (`getOperationState`); the row is the record.
- PLATFORM_ADMIN only; the page 404s for everyone else.

## Parameters (PlatformConfig)

| Parameter | Setter | Human input | Bounds |
|---|---|---|---|
| Platform fee | `setFeeBps(uint16)` | % (2 decimals) | 0 – 5 % |
| Success threshold | `setSuccessThresholdBps(uint16)` | % | 0.01 – 100 % |
| Vote window | `setVoteWindow(uint32)` | number + minutes/hours/days | 1 hour – 14 days |
| Quorum | `setQuorumBps(uint16)` | % | 0.01 – 100 % |
| Approval | `setApprovalBps(uint16)` | % | 50.01 – 100 % |
| Refund sweep delay | `setRefundSweepDelay(uint32)` | days | 30 – 365 days |
| Minimum donation | `setMinDonation(uint256)` | USDC (6 decimals) | > 0 |
| Release delay (single payout) | `setReleaseDelay(uint32)` | number + minutes/hours/days | 0 – 7 days |
| Treasury | `setTreasury(address)` | address | non-zero |
| Emergency Pool | `setEmergencyPool(address)` | address | non-zero |

## Tests

- Unit: every conversion both ways, bounds, rejects of floats/garbage; operation id equals OZ `hashOperationBatch` (checked against a value computed with `cast`); payload decoding to a human summary; Safe JSON shape.
- Integration: API (admin only, operation id recomputed, foreign target/selector rejected, duplicate rejected, execute/cancel transitions, audit rows).
- E2E (034b): admin sees the console; non-admin 404; with a fake wallet the change form builds the expected `scheduleBatch` call.

## Owner guide (David, 2026-10-04 09:30)

*"potrebovali bomo tudi pdf navodila za ownerje … kako urejat pametne pogodbe, kaj kaj pomeni, katere funkcije, kakšne vnose, kako hitro se naredi sprememba … source si shrani ker bomo nadgrajevali to tekom razvoja"*

- Source `docs/guides/owner/contracts-owner-guide.md` (Markdown + front matter), built with the whitepaper's design: `cd docs/whitepaper && npm run owner-guide` → `docs/guides/owner/dist/CHERR.IO-Contracts-Owner-Guide-v<version>.pdf` (committed).
- Content: the contracts and addresses, roles and who holds them, how long a change takes (timelock delay per network), every PlatformConfig setting (meaning, input, bounds, default), Admin → Contracts step by step, the 1-hour Amoy test window example, other owner actions and where they are done, manual Polygonscan fallback, troubleshooting.
- **Maintenance rule:** every PR that changes the contracts, roles, deployment or Admin → Contracts updates the guide, raises its version, adds a change-log line (`docs/guides/owner/README.md`) and rebuilds the PDF (also in `docs/technical/README.md` maintenance and in HANDOFF).

## Must not touch

- Contracts, deploy scripts, the timelock delay, role grants.

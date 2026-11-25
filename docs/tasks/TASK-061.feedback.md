# TASK-061 feedback
Status: PARTIAL — 061a done; 061b done (live on dev, run 45607120118); 061c live on dev (#238, #239); 061d crew run live on dev (run 45624222186); 061e–f open

## 061a — runner core (2026-11-24)

### What I implemented
- New workspace package `apps/agents` (no service, no image): crew wallets from one mnemonic, the dev-only guard, the signer policy, the wallet bridge for Playwright (EIP-1193 + EIP-6963), the top-up plan and CLI, the run log with redaction, budget caps, and model routing (dispatcher on Opus 5.5, cheaper tiers for the work — David 2026-11-24).

### Files changed
- `apps/agents/**` — the package and its tests
- `pnpm-lock.yaml` — the new importer
- `docs/technical/11-testnet-agents.md` (new), `README.md`, `06`, `07`, `09` — see below

### Deviations from the task (and why)
- Model routing (`models.ts`) is not in the 061a list of the spec: David asked for it while 061a was being written. The spec and ADR-063 get the paragraph in a docs PR once the spec PR (#222) is merged.
- No Playwright dependency yet: the bridge is plain functions plus a script string, so it is tested without a browser. Playwright arrives with the workflow in 061b.

### New dependencies
- none new to the repo (`viem` is already used by web, indexer, shared and contracts)

### How to verify
1. `pnpm --filter agents test` → 23 passed
2. `AGENT_MNEMONIC="test test test test test test test test test test test junk" pnpm --silent --filter agents addresses` → nine lines, index 0 = `0xf39f…2266` (the public Anvil phrase)
3. Without `AGENT_MNEMONIC` → `AGENT_MNEMONIC is required`, exit 1

### Test results (this session)
```
 ✓ test/core.test.ts (23 tests) 120ms
      Tests  23 passed (23)
```
`pnpm --filter agents typecheck` and `lint`: no errors.

Deliberate breaks (each restored with the reverse `sed`, then 23 passed again):
| Break | Result |
|---|---|
| Guard compares the origin with `startsWith` | `× guard > accepts the testnet on Amoy only` (`https://testnet.cherr.io.evil.example` got through) |
| `freeze` added to the campaign allow-list | `× signer policy > never signs Guardian calls, for anyone` → `donor: expected true to be false` |
| Bridge ignores a refusing verdict | `× wallet bridge > sends an allowed transaction and never sends a refused one` → `promise resolved "'0xabab…'" instead of rejecting` |

NOT RUN — `pnpm --filter agents fund`: needs an Amoy RPC and a funded treasury; the sandbox reaches neither. Its arithmetic (`planTopUps`) and the policy it calls are covered by the tests above.
NOT RUN — anything against testnet.cherr.io (unreachable from the sandbox).

### Open questions / risks
- Whether Privy's sign-in window accepts the injected wallet in headless Chromium is only known after the first live run (061b). Fallback: Privy's own test accounts.
- Typed-data signing is limited by chain only; when 061d uses ratings, tighten it to the app's own EIP-712 domain.
- Reports as GitHub Issues would be public in this repository — a private reports repository is recommended (David to decide before 061d).
- The lockfile change makes the next dev Deploy re-index (indexer inputs include `pnpm-lock.yaml`).

### docs/technical chapters updated
11 (new), README (chapter list), 06 §10, 07 §5, 09 (§2 and the task table).

### Suggested commit message
feat(agents): runner core for the testnet crew (TASK-061a)

## 061b — first live flow (2026-11-25)

### What I implemented
- `apps/agents/src/run.ts` (flow `donor`), `src/chain.ts` (agents' RPC, policy context, signer that passes the page's gas/fee fields), workflow `.github/workflows/agents.yml` (manual, dev only, environment `agents`, artifact upload).
- Bridge: `TxRequest` carries `gas` / `maxFeePerGas` / `maxPriorityFeePerGas` through to the signer (not part of the policy). Run log: exact secret values (the RPC URL) are redacted too.
- First-run top-up levels 2 → 5 USDC (David's treasury had 20 USDC from the faucet).

### Deviations
- No model in this flow: login and donation are fixed steps, so the first run costs no tokens. The dispatcher arrives with 061d.
- Secrets in a GitHub **environment** `agents` without a branch rule (David's plan does not offer deployment-branch rules); the job itself runs only when `github.ref == refs/heads/dev`.

### Test results (this session)
- `pnpm --filter agents test` → 25 passed (2 new: URL redaction, fee pass-through); typecheck and lint clean; `actionlint` on `agents.yml` clean.
- Smoke in a real headless Chromium (temporary script, not committed) with the public Anvil phrase: `{"seen":["CHERR.IO test wallet"],"chain":"0x13882","accts":["0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"],"block":"0x10","refused":"4100 method not allowed: eth_sign"}` — the page sees the EIP-6963 wallet, identity and reads work, a non-allowed method is refused.
- NOT RUN — the live flow (testnet unreachable from the sandbox; secrets live in GitHub). First run: Actions → Agents → Run workflow on `dev`.

### Risks
- Privy's sign-in window may name the wallet button differently or ask for an extra click; the run takes screenshots of each step and fails with the step name.

### Independent review (read-only subagent) and fixes, before the first run
| Finding | Rating | Fix |
|---|---|---|
| Typed data checked only by chain: a page could ask for a USDC EIP-2612 `Permit` (moves USDC with no transaction the policy sees); signer address not checked | HIGH | `checkTypedData`: only the app's `Rating` message (exact domain and types); signer must be the wallet — 2 tests; deliberate break (primary-type rule off) → `signs only the app's own rating message…` failed |
| Wallet answered every frame and origin (iframe, redirect) | HIGH | `exposeBinding` + top frame on the testnet origin only. Real Chromium: `{"top":"0x13882","inFrame":"error 4100","elsewhere":"error 4100"}` |
| Page-chosen gas/fees passed to the signer unchecked | MEDIUM | `checkFees` caps — test; deliberate break (check skipped) → `refuses fees above the caps…` failed |
| Error texts (can contain the RPC URL) returned to the page and into the summary | MEDIUM | page gets codes only; step details, summary and the final error redacted |
| Secrets usable from any branch that edits the workflow (job `if:` only) | MEDIUM | Not fixable on David's plan (no deployment-branch rules); only collaborators can push branches. Accepted, documented |
| Slug from the URL; refused methods only in run.jsonl; actions pinned by tag | LOW | slug from the API; rest left as is |

Tests after the fixes: agents 28 passed; typecheck, lint clean.

### First live run (2026-11-25, Actions run 45595521830)
- `guard` ✓, `top-up` ✓ — 2 transfers from the treasury to donor-1 on Amoy (POL and USDC).
- `pick campaign` ✗ — "no live campaign": the runner compared with `LIVE`, the public API reports `live` (lower case, `PublicState`). Fixed in `fix/agents-live-state`; second run below.

### Runs until the first end-to-end donation (2026-11-25)
| Run | Result | Fix |
|---|---|---|
| 45596868393 | failed after 37 s with no step annotations | steps printed synchronously (#230) |
| 45598597151 | Privy window open, no "CHERR.IO test wallet" button | diagnostics: visible buttons + wallet calls (#232; worker tests `--no-file-parallelism` after three CI flakes) |
| 45601917695 | Privy lists MetaMask, Coinbase, Rainbow, WalletConnect wallets — no other injected wallet | wallet presents as MetaMask in the agents' browser (#233) |
| 45603596943 | `wallet_requestPermissions` refused → Privy "Retry" | grant `eth_accounts` only (#234) |
| 45605361497 | **sign in ✓ (`/api/auth/session` 200), donation on chain ✓, indexed ✓ (API = chain, 1096300)**; the step check expected exactly 1 USDC, but the goal was in EUR (typed 1 → 1.0963 USDC) | compare with the amount the page shows (`You send exactly … USDC`) |
| 45607120118 | **all green**: guard, top-up, pick, sign in, donation (typed 1 → page 1.0963 USDC → `donated()` +1.0963), indexed (API 2192600 = chain) | — |

## 061c — crew marking, step 1: migration `0026` (2026-11-25)
Expand first (HANDOFF rule): this PR adds only the column — SQL, journal, snapshot. `packages/db/src/schema/users.ts` is unchanged, so the code running on dev (`select()` on `users`) does not see the column yet. The code PR (crew registry in `@cherrio/shared`, flag set at login on dev, `is_demo` for the crew's organisations and campaigns) follows after this one is deployed.

- `packages/db/drizzle/0026_users_is_agent.sql` — `ALTER TABLE "app"."users" ADD COLUMN "is_agent" boolean DEFAULT false NOT NULL;`
- snapshot generated by adding `isAgent` to `users.ts`, `pnpm db:generate --name users_is_agent`, then reverting the `.ts`.

### Test results (this session)
- `pnpm --filter @cherrio/db migrate` → `Migrations complete.`; `\d app.users` shows `is_agent | boolean | | not null | false`.
- `pnpm --filter @cherrio/db test:integration` → `Tests 19 passed (19)` (no new table, so the expected-table list is unchanged).
- `pnpm --filter web test` before the change → `Tests 636 passed (636)`; the column is invisible to the code until the next PR.

### docs/technical chapters updated
- 03 (`users` row: `is_agent`, Built).

## 061c — crew marking, step 2: code (2026-11-25)
Stacked on the migration branch; the PR is opened from a fresh branch off `dev` once `0026` is merged and deployed.

### What I implemented
- `packages/shared/src/agent-crew.ts` (export `@cherrio/shared/agent-crew`): the nine public crew addresses, `agentCrewEnabled` (local, dev only), `crewMemberFor`, `agentDisplayName`.
- Login (`apps/web/src/app/api/auth/session/route.ts`): a crew wallet → `is_agent = true`; a new agent user is named "Agent <name>"; an existing user is marked at the next login; never cleared.
- `submitOrganizationApplication`: agent's new organisation `is_demo = true`; an agent claiming an imported organisation is refused (`organization_exists`).
- `createDraft`: `is_demo` when the starter is an agent or the organisation is demo.
- Worker `insertAwards`: no points for agents.
- Admin → Demo campaigns: agents' campaigns and organisations left out (no "Publish all" for them; their payout address is not the form's default).
- `apps/agents`: `CREW` built from the shared registry; `assertCrewMatchesRegistry` at the start of `run.ts`.
- `packages/db/src/schema/users.ts`: `isAgent`.

### Places that assume "`users.is_demo` never logs in" — checked
`lib/demo/create.ts` (legacy repair keeps only `is_demo` members; existing demo organisations are picked by a synthetic `is_demo` member), worker registration points (`not u.is_demo and u.privy_did is not null`). Crew users are `is_agent`, never `is_demo`, so none of them changes. `createDemoCampaigns` counts all `is_demo` organisations for its seed offset — agents' organisations shift which seed name comes next; harmless, left as is.

### Deviations
- Not in the spec, added on purpose: agents never claim imported organisations (a real charity must not end up controlled by an agent), and agents earn no points (the spec says agent content stays out of points; a donation by an agent to a real campaign would otherwise still earn points).
- "Agent <name>" display name for new agent users, so the public `/en/agents` page (061f) and campaign donor lists show who is an agent.

### Test results (this session)
- `pnpm --filter web exec vitest run src/__tests__/agent-crew-marking.test.ts` → `Tests 7 passed (7)`.
- Deliberate breaks (login flag forced false, claim guard disabled, draft ignoring the agent flag) → `Tests 3 failed | 4 passed (7)`: "a new user with a crew wallet becomes an agent…", "an agent never claims an imported organisation", "a campaign started by an agent is is_demo…"; restored with the reverse `sed` → 7 passed.
- Worker: new test "testnet agents earn nothing…"; with the agent filter disabled it fails at `test/worker.test.ts:194` (`status(agent)` not empty); restored; `pnpm --filter worker test` → `Tests 41 passed (41)`.
- `pnpm --filter @cherrio/shared test` → `Tests 116 passed (116)` (4 new).
- `pnpm --filter agents test` → `Tests 31 passed (31)` (3 new: registry order, a foreign mnemonic refused, one changed address named).
- `pnpm --filter web test` → `Test Files 81 passed (81)`, `Tests 643 passed (643)`.
- typecheck + lint (all but contracts) clean; `pnpm check:design` → "Design check passed".
- NOT RUN: E2E (no visible UI change besides the admin demo list filter), live run on the testnet (from GitHub Actions after the Deploy).

### Risks
- A crew address already linked to a real user on dev would still be marked at that user's next login. The crew addresses are fresh HD wallets used only by the runner, so this is not expected.

### docs/technical chapters updated
- 11 §5 (new), 03 (`users.is_agent`), 09.

## 061d — crew run: dispatcher, personas, bug reports (2026-11-25)

### What I implemented
- `src/llm.ts` — Anthropic Messages API over HTTPS (no SDK); every call is charged to the token budget before it is sent; an error never echoes the response body.
- `src/dispatcher.ts` — the dispatcher (`claude-opus-5-5`) plans from a short testnet summary; the plan passes `placeAssignments` and `checkRunnable` (runnable task, allowed persona, ≤ 8) or the default plan runs, with the reason logged.
- `src/flows.ts` — donate, pool-give, share-check, awkward-use (390 px, wrong amounts, double click, back/forward, page width); index checks queued and run once at the end (two indexer cycles).
- `src/browser.ts` — one Playwright context per agent with its own wallet (moved from run.ts); every send passes `beforeSend` (transaction budget).
- `src/observe.ts` — soft observations by the task's tier model on the page text; summary and log only.
- `src/reports.ts` — GitHub Issues in the private reports repository: fingerprint de-duplication (comment "seen again"), ≤ 10 new issues per run, redacted bodies, nothing sent without token + repository.
- `src/run.ts` — flow `crew` (flow `donor` unchanged in effect); `src/runlog.ts` — `remarks` keep prose (the exact mnemonic is now passed as a secret).
- Workflow: flow `crew`, `timeout-minutes: 45`, `ANTHROPIC_API_KEY`, `AGENTS_REPORT_TOKEN`, `AGENTS_REPORT_REPO` into the run step.

### Deviations
- Fundraiser flows (organisation application with KYB files, campaign draft + submit), voting and rating are **not** in this PR: voting and rating need campaigns in those states, and the fundraiser's submissions are only useful once the staff agent (061e) reviews them. They come with 061e. Spec 061d listed "all personas".
- Soft observations are not grouped weekly yet (spec: "grouped weekly"); they are in each run's summary. Grouping comes with Admin → Agents (061f).

### Test results (this session)
- `pnpm --filter agents test` → `Tests 53 passed (53)` (22 new in `test/crew-run.test.ts`).
- Deliberate breaks, one run: persona check removed from `checkRunnable`, the budget charge in `ask()` skipped, the fingerprint on the raw detail → `Tests 6 failed | 16 passed (22)` (the two budget tests, three dispatcher fall-back tests, the fingerprint test); restored → 53 passed.
- `pnpm --filter agents typecheck`, `lint` clean.
- NOT RUN here: the flow against the testnet (unreachable from the sandbox) — first run from GitHub Actions after the merge; actionlint (its binary download was refused in the sandbox; the workflow change is three lines).

### Independent review (read-only subagent) and fixes
- HIGH: a send refused by the transaction cap was caught inside the wallet binding, the page timed out, the task was recorded as a bug and the run went on → `session.budgetHit`, the runner stops with `budget: stopped`.
- MEDIUM: errors were cut to 300 characters before redaction (a cut RPC URL would not match) → redact first, then cut to 600; top-level handlers redact all four secrets.
- MEDIUM: a throw in top-ups, the campaign list or the index checks skipped reports and summary → each recorded as a step.
- LOW–MEDIUM: comments uncapped, de-duplication read only 100 issues, Markdown break-out from the code block → `MAX_COMMENTS` 10, up to 3 pages, `neutral()` (no backticks, no @, no marker).
- LOW: URLs from the API / `og:image` not checked against the testnet origin → `onTestnet`; observations as raw Markdown → stripped; `isVisible({timeout})` does not wait → `waitFor`; minimum message matched the always-present details line → the field error `#donate-amount-error`; `ANTHROPIC_API_KEY` also for `donor` → crew only.
- Playwright traces held the agent accounts' session cookies in a public artifact → traces dropped (screenshots + redacted log stay).
- Not changed: the `agents` environment has no deployment-branch rule (David's plan, accepted 2026-11-25; the job also checks `refs/heads/dev`).
- After the fixes: `pnpm --filter agents test` → `Tests 54 passed (54)`; typecheck and lint clean.

### First crew run (2026-11-25, Actions run 45622175784)
- Plan from the **dispatcher** (Opus): donor-1 donate, donor-2 share-check, awkward-1 awkward-use (it left out pool-give — no sub-pool on the page yet, and donor-3).
- ✓ guard, top-up (2 transfers for donor-1, awkward-1), donor-1 sign in + donation (typed 1 → 1.0963 USDC, `donated()` 0 → 1.0963), donor-2 share link (200, og:title) + preview image (200 image/png), awkward-1 phone width 390 px, sign in from "Log in to donate", letters → error + Donate disabled.
- ✗ "zero as amount": the app answers "0" with "Enter an amount, for example 25." (not an amount), not the minimum message — **the agent's expectation was wrong, not the app** → the check now types 0.5 ("below the minimum"). The issue this filed in the reports repository is a false report (to close).
- The remaining steps were not visible: GitHub shows at most 10 notices per step → passed steps are now one notice per agent at the end; failures stay one error each (`fix/agents-annotations-minimum`).

### Second crew run (2026-11-25, Actions run 45624222186) — all green
- Plan from the dispatcher: donor-1 share-check, awkward-1 awkward-use (it skipped donations this time).
- awkward-1 on a 390 px phone: page width ✓, sign in from "Log in to donate" ✓, letters → error + Donate disabled ✓, 0.5 → minimum message + Donate disabled ✓, **double click → exactly 1 donate transaction** ✓, back + forward ✓, indexed (API 1096300 = chain 1.0963 USDC) ✓. donor-1: share link 200 with og:title ✓, preview image 200 image/png ✓. Top-up: nothing needed.
- Observations (Haiku, not bugs): (1) after back + forward the donate box said "Donating is not available right now" with no reason while the "Donate to this campaign" bar still showed — worth a look in 061e (donate box state after a back/forward navigation); (2) "Succeeds at 10%" is unclear; (3) "Paid in one go or in three steps" does not say how a donation is released.

## 061e part 1 — fundraiser tasks (2026-11-25)
Status: PARTIAL (built and unit-tested; the live run follows the merge)

### What I implemented
- `apps/agents/src/fundraiser.ts` — `start-organisation` (application with a drawn PDF register extract + PNG authorisation, own wallet as payout address, waits for "Waiting for review") and `start-campaign` (only with a verified organisation and nothing in flight: draft, goal €100/200/300, 21 days, drawn JPEG cover, submit, waits for "Our team is checking your campaign"). Texts from the explore model as checked JSON, with a fixed fallback; the runner adds " (testnet)" and the agent marker. A reached organisations/campaigns cap skips only that task.
- `dispatcher.ts` — both tasks runnable by the fundraiser persona; default plan 8 tasks (both fundraisers start an organisation, fundraiser-1 a campaign).
- `run.ts` — the two tasks need no live campaign and no top-up; an unknown task now fails loudly instead of doing nothing.

### Deviations
- No local end-to-end run of the two tasks: they need Privy sign-in, which exists only on the testnet (the sandbox cannot reach it). The selectors are those of the green E2E specs `organization.spec.ts` and `campaigns.spec.ts`; the first Agents run after the merge is the live proof.
- Daily caps (≤ 1 organisation / ≤ 3 campaigns a day) are enforced as per-run caps plus "one in flight per fundraiser"; with manual runs that is the stricter limit. A real per-day counter comes with the schedule (061f).

### Test results (this session)
- `pnpm --filter agents test`: `Test Files  3 passed (3)` · `Tests  60 passed (60)` (54 before + 6 new in `test/fundraiser.test.ts`). The old case "a task the runner cannot do yet" now uses `vote` (start-campaign is runnable).
- `pnpm --filter agents lint` and `typecheck`: clean.
- Deliberate breaks: marker no longer added to the organisation description → `FAIL … always adds the testnet suffix and the agent marker` (`Tests  1 failed | 59 passed`); links no longer refused → `FAIL … refuses links …` `Pay at https://example.org today: expected … to be null`. Both restored → 60 passed.
- `draw()` in Chromium (`/opt/pw-browsers`): `pdf 15739 bytes, starts 25504446` (`%PDF`), `png 26956 bytes, starts 89504e47`, `jpeg 29781 bytes, starts ffd8ffe0`.
- Live run: NOT RUN yet — after merge (workflow Agents, flow crew).

# TASK-061 feedback
Status: PARTIAL — 061a done; 061b done (live on dev, run 45607120118); 061c live on dev (#238, #239); 061d crew run live on dev (run 45624222186); 061e part 1 live on dev (#246); 061e part 2 step 1 (staff authenticator) built; rest of 061e and 061f open

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
Status: DONE (merged #246, live run 45642806416 green)

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
- Live run **45642806416** (workflow Agents, flow crew, dev `f4104b57`), conclusion `success`. Annotations as read:
  - `fundraiser-1 · texts: organisation "Lantern Hill Reading Fund (testnet)" from claude-sonnet-5-5`
  - `fundraiser-1: ✓ sign in: POST /api/auth/session → 200 · ✓ organisation submitted: "Lantern Hill Reading Fund (testnet)" is waiting for review · ✓ sign in … · ✓ start campaign: skipped — the organisation is not verified yet (waits for review)`
  - `fundraiser-2: ✓ sign in … · ✓ start organisation: skipped — budget reached: organisations (cap 1) · ✓ sign in … · ✓ start campaign: skipped — the organisation is not verified yet (waits for review)`
  - the other personas all ✓ (donate 1.0935 USDC + indexed, pool 2 → 3 USDC, share link + preview, awkward: 390 px, letters, 0.5, double click → 1 transaction, back and forward).
  - Observations (soft): the fundraiser page gives no estimate of how long the review takes; "Preparing your wallet…" (the #244 text) has no explanation — the old "not available" message no longer appears after Back/Forward.

### Independent review (read-only subagent, before merge)
- Selectors checked against the form components and `en.json`: OK. Budget stops: OK (organisation/campaign cap skips the task with `report:false`; a token cap stops the run as before).
- MEDIUM fixed: a line break in a model-written name or title would be flattened by the input (false "not shown as waiting" bug) and could start a new workflow command in the log → names and titles must be one line (`checkText(…, oneLine)`), annotation text flattened. Break shown: one-line check removed → `FAIL … refuses links …`; restored → 60 passed.
- LOW, left: a *rejected* organisation is not re-submitted ("Submit again"); the agent registers a new one, still at most one per run. A text with a year range like "2024-2025" goes to the fixed text (the long-number rule) — harmless.

## 061e part 2, step 1 — the staff agent's admin authenticator (2026-11-25)
Status: DONE (merged #248; staff agent enrolled on the testnet by David, 2026-11-25)

### What I implemented
- `apps/agents/src/staff.ts` — RFC 6238 TOTP with the admin gate's parameters (SHA-1, 6 digits, 30 s; repeated, not imported from `apps/web`); `adminGate` (404 → `not-admin`, enrolment screen, code screen, or `open` = the "Admin menu" navigation); `enrolSecondFactor` (show key → code → 10 recovery codes → continue, re-click if the page was not hydrated); `passSecondFactor` (waits for the next step after the enrolment code); `saveEnrolment` (two files, 0600, key without newline).
- `apps/agents/src/cli.ts` — `enrol-staff [--dir <folder>]`: sign in through Privy → 404 → prints the `grant-admin` command (exit 3); enrolment → files → drops the `cherrio_admin_mfa` cookie and passes the code screen with the saved key → prints the `gh secret set AGENT_STAFF_TOTP_SECRET --env agents …` line. Existing factor: checks `AGENT_STAFF_TOTP_SECRET` if set, else prints the reset command. Nothing secret is printed; no screenshot after sign-in.
- `apps/agents/src/run.ts` — `AGENT_STAFF_TOTP_SECRET` added to the redacted secrets.
- `package.json` script `enrol-staff`.

### Deviations
- The spec says "run the enrol CLI locally once"; it is two runs because `grant-admin` needs the user row that only the first sign-in creates. The CLI says which step comes next.
- The workflow does not pass `AGENT_STAFF_TOTP_SECRET` yet: nothing in the run uses it until the staff review flow exists (next step).

### Test results (this session)
- `pnpm --filter agents test`: `Test Files  4 passed (4)` · `Tests  65 passed (65)` (60 before + 5 in `test/staff.test.ts`: RFC 6238 vectors at T=59 … 20000000000, base32 as the page shows it, next-step wait, file modes 0600 incl. an existing 0644 file).
- `pnpm --filter agents lint` and `typecheck`: clean.
- Deliberate break: HOTP offset mask `0x0f` → `0x07` → `× … matches the RFC 6238 test vectors` `AssertionError: T=59: expected '33376225' to be '94287082'` (`Tests  1 failed | 4 passed (5)`); restored → `Tests  5 passed (5)`.
- Real pages: a one-off Playwright spec (not committed) drove `adminGate` / `enrolSecondFactor` / `passSecondFactor` against a local `next build` + `next start` (E2E session cookie instead of Privy). First attempt failed at both widths and showed two driver errors: (1) "Admin Portal" is a label above the "Overview" heading, not a heading — the open state is now the "Admin menu" navigation; (2) at 390 px the "Show the QR code" click happened before hydration and did nothing (`waiting for getByTestId('mfa-secret')` 30 s) — now clicked again up to three times. After the fixes, `--repeat-each=2` at 1440 and 390: `4 passed (2.1m)`, each printing `plain user: not-admin` · `admin without factor: enrol` · `enrolled: key length 32, recovery codes 10, step 59854045` · `after dropping the 12-hour cookie: verify` · `passed the code screen with step 59854046 after 17 s` · `open: open`.
- NOT RUN in the sandbox: `enrol-staff` against https://testnet.cherr.io (unreachable from here; the mnemonic stays with David).
- **Live, run by David on his Mac (2026-11-25 17:43–17:45, dev image `d40a0ed`, `AGENT_RPC_URL=https://rpc-amoy.polygon.technology`), output as he pasted it:**
  - 1st run: `✓ sign in: POST /api/auth/session → 200` · `The staff agent 0x31e76078393e4d8a7e9209482f6c7319a0e93e28 has signed in, but it is not an admin yet (/en/admin → 404).` · `Exit status 3`
  - server: `Granted PLATFORM_ADMIN role to user 01a21396-9d35-7043-8262-12a1f184f45a (0x31e76078393e4d8a7e9209482f6c7319a0e93e28).`
  - 2nd run: `✓ sign in: POST /api/auth/session → 200` · `✓ authenticator set up; key and recovery codes saved (0600):` (two paths in `~/.cherrio/`) · `… waiting for the next 30-second code to check the saved key` · `✓ the saved key opens the admin area`
  - `gh secret set AGENT_STAFF_TOTP_SECRET --env agents …` → `✓ Set Actions secret AGENT_STAFF_TOTP_SECRET for DataVallis-CHERR-IO/web3-platform`

### Independent review (read-only subagent, on PR #248)
- TOTP identical to `apps/web/src/lib/auth/totp.ts`; selectors match the real components; `adminGate` cannot misclassify (404 is a real status; no screen → clear error).
- MEDIUM fixed: the key was saved only after the whole enrolment — a failure after Confirm (factor already confirmed on the server) would lose it → the key is written to its file before Confirm, the codes as soon as they are read.
- MEDIUM fixed: the CLI's catch printed `error.message` unredacted; viem errors name the RPC URL with its key → redacted with `AGENT_RPC_URL`, `AGENT_MNEMONIC`, `AGENT_STAFF_TOTP_SECRET` (also covers `fund`).
- LOW fixed: an existing folder is set to 0700 and an existing file to 0600 *before* the secret is written; no second click once the key is shown. Break shown: folder chmod removed → `× … tightens the mode of a file and a folder that already exist` `expected 493 to be 448`; restored → `Tests  65 passed (65)`.
- LOW left: running `enrol-staff` twice within 30 s on an enrolled agent fails once (the code was used); the temporary login-screenshot folder is not deleted (no secrets); symlinks are followed (single-user laptop).
- Real pages again after the fixes (1440 + 390): `file key matches: true, codes in file 10, modes 600/700` · `saved key passed with step 59854059 (enrolment step 59854058); gate: open` · `2 passed (58.4s)`.

### Docs
- `docs/technical/11-testnet-agents.md` §8 (new) and §9, `09-status-and-roadmap.md`, `docs/CHEATSHEET.md`, owner guide v1.18 (§8 "The staff agent (test network only)") + PDF.


## 061e part 2, step 2a — the staff agent reviews the crew's organisation applications (2026-11-25)
Status: DONE (Built; first live run after merge)

### What I implemented
- `apps/agents/src/review.ts` — deterministic checks (`checkOrganisation`), the classifier (`classify`, review tier, texts + every document, fail closed), `parseVerdict`, `auditNote`.
- `apps/agents/src/staff-review.ts` — the `review-submission` task: sign in → admin gate (`AGENT_STAFF_TOTP_SECRET`) → `/en/admin/kyb` → each application (≤ 10 opened, ≤ 3 decided); only applications marked "Testnet agent of the CHERR.IO crew" are decided; pass → approve dialog with the payout tail and the audit note; hold → `agent-hold` issue.
- `apps/agents/src/reports.ts` — `fileHolds` (one open issue per held submission, redacted, marker-deduplicated).
- `apps/agents/src/llm.ts` — `attachments` (PDF document / PNG-JPEG image blocks), 3,000 budget tokens each, charged before the call.
- Runner + plan: `review-submission` runnable by `staff`, once in the default plan between the applications and `start-campaign` (plan cap 8 → 9); no soft observations on admin pages; holds filed after the bug reports; workflow passes `AGENT_STAFF_TOTP_SECRET` to the `crew` run step.
- Web: server guard `agent_scope` in `lockForReview` (approve + reject); optional approve `note` (≤ 500) → `audit_log.data.note`; approve dialog field "Note for the audit log (optional)"; applicant line "Testnet agent of the CHERR.IO crew (not a real person)." on the application page.

### Deviations
- Organisations only in this PR; campaign review, publishing and payout mode are the next step (PR size).
- The spec's "submitter is a crew member" is checked through the server's `is_agent` marking shown on the page plus the payout address being a crew wallet — the admin page does not show the applicant's wallet (personal data), and the server refuses the rest anyway.
- No screenshot pair in the PR for the two small admin text additions; the one-off local check drove both widths.

### Test results (this sandbox)
- `pnpm --filter agents test`: `Test Files  5 passed (5)` · `Tests  89 passed (89)` (65 → 89).
- `kyb-review.test.ts` (Postgres): `Tests  9 passed (9)`. Deliberate break — guard line removed: `× … TASK-061e: a testnet agent admin reviews only applications of other agents; a person's waits` · `expected { status: 200, … } to deeply equal { status: 409, … }` · `Tests  1 failed | 8 passed (9)`; restored.
- Deliberate break — classifier failure returns pass: `× classifier (classify) — fail closed > HTTP 500 → hold`, `… prose instead of JSON → hold`, `… an unknown verdict → hold`, `… the budget is spent before the call …` · `Tests  4 failed | 85 passed (89)`; restored → `Tests  89 passed (89)`.
- `pnpm --filter web test`: `Tests  647 passed (647)` (645 + 2).
- Local `next build` + one-off uncommitted Playwright spec driving `reviewQueue` (fake classifier), both widths: `"detail": "approved \"Lantern Hill Wide heafcg (testnet)\" (checks + claude-sonnet-5-5: pass)"`, `"2 waiting; 1 decided by the agent, 1 left for a person"`, `"attachments": 2`, audit `{"note":"Staff agent (TASK-061e): deterministic checks passed; classifier claude-sonnet-5-5: pass — fictional testnet charity","claim":false,…}`; `2 passed (15.4s)`. First attempt: held with "the name has a link, e-mail, address or long number" — the test names carried a timestamp; renamed.
- E2E `kyb-review.spec.ts` + `admin-hidden.spec.ts` against the same build: `8 passed (34.0s)`.
- lint / typecheck (web, agents), `pnpm check:design`: clean.

### Independent review (read-only subagent)
- HIGH ×2: the queue screenshot and the failure screenshot could show real applicants in the public artifact → no queue screenshot, no failure screenshot for `review-submission`.
- MEDIUM ×2: the agent line and the "reviewed" text were matched page-wide → scoped to the Applicant / Decision sections, plus the Approved chip and no alert.
- LOW-MEDIUM: an agent could approve a legacy claim of an imported organisation → server refuses `claim || !is_demo` too (test: break → `Tests  1 failed | 8 passed (9)`, restored → `9 passed`).
- LOW ×2: Markdown links/images from model reasons in hold issues and the audit note → removed.
- Left (LOW): a held crew application is re-classified each run; only the first 10 queue entries are opened.

### Open questions / risks
- The first live run decides "Lantern Hill Reading Fund (testnet)" — unless David approved it by hand already.
- A hold costs one issue per submission; a submission held again while its issue is open is not re-filed.

### Docs
Chapter 11 §9 (new) / §10, 09, 06 (KYB review row), 04 (admin KYB page row).

### Live run and fix (2026-11-25)
- PR #250 merged by David; Deploy 45665145458 `completed success`.
- Crew run **45665462416** (annotations): `✓ plan: dispatcher: …`; `failure | staff · review organisation | "Lantern Hill Reading Fund (testnet)": approval not shown as saved` (twice — fundraiser-1 and fundraiser-2 had applications with the same model-written name); then `fundraiser-1 … ✓ campaign submitted: "Books and Reading Corners for a Small Village Library", goal €100, 21 days — waiting for review` and fundraiser-2 texts `campaign "Picture books and cushions for a children's reading corner"` — a campaign can only be started with a verified organisation, so both approvals were saved. `reports | 1 new issue(s) #2` = this false failure.
- Cause: the "no `role=alert`" condition added after the local proof (review fix) is never true — Next.js renders its route announcer with `role="alert"` on every page.
- Fix (`fix/agents-staff-approve-check`): after the click, reload; saved = Decision section text + Approved chip. Local one-off spec (real `reviewQueue`, local `next build`): `✓ [chromium-1440] … approval recorded as saved`, `✓ [chromium-390] …` — `2 passed (19.9s)`. Deliberate break — old condition back: `"ok":false,"detail":"\"Lantern Hill kkbdkd (testnet)\": approval not shown as saved"` · `1 failed` (the live symptom exactly); restored. `pnpm --filter agents test`: `Tests  89 passed (89)`.
- Lesson: a change made after the local proof is re-proved locally before the PR.

## 061e part 2, step 2b — the staff agent reviews the crew's campaigns (2026-11-25)
Status: DONE (Built; first live run after merge)

### What I implemented
- `apps/agents/src/review.ts` — `CampaignSubmission`, `checkCampaign` (agent starter, crew payout, title/story present, campaign marker, no contact data outside the marker, known cause label, Slovenia, goal in euros ≤ €1,000, cover, no extra media), `MAX_CREW_GOAL_EUR`.
- `apps/agents/src/staff-review.ts` — `reviewCampaignQueue` after the organisation queue in the same `review-submission` task: `/en/admin/campaigns` → each campaign (≤ 10 opened, ≤ 3 decided); decided only with the server-rendered "Crew agent" row; `decideCampaign` (checks → classifier on texts + cover); pass → approve dialog with the audit note; hold → `agent-hold` issue (`kind: "campaign"`).
- `apps/agents/src/llm.ts` — `image/webp` attachments (covers are WebP).
- Web: `agent_scope` in campaign `lockForReview` (approve + reject: agent reviewer only for an agent starter + demo campaign + demo organisation); approve body `{ note?: string ≤ 500 }` (strict) → `audit_log.data.note`; approve dialog field "Note for the audit log (optional)"; "Crew agent" row in "Campaign data"; messages `admin.campaigns.approveNote`, `approveNoteHint`, `fields.agent`, `starterAgent`, `errors.agent_scope`.

### Deviations
- Publishing (`createCampaign` signed by the staff wallet), linking and payout mode are the next PR (size).
- Campaigns started in a run are reviewed in the next run (the task runs once, before `start-campaign`; plan cap unchanged).
- The goal check reads the euro amount from the "Goal" cell, because the display currency can show "≈ $14,081 (€12,000)".

### Test results (this sandbox)
- `pnpm --filter agents test` (before the review fixes): `Test Files  6 passed (6)` · `Tests  107 passed (107)` (89 → 107). Deliberate break — starter check off: `× deterministic checks (checkCampaign) > a person's campaign → hold`, `× decision (decideCampaign) > failed checks hold without reading the cover or calling the model` · `Tests  2 failed | 16 passed (18)`; restored.
- `campaign-review.test.ts` (Postgres): `Tests  12 passed (12)` (10 + 2). Deliberate break — guard disabled: `× … the staff agent decides only demo campaigns that a crew agent started; its audit note is kept (TASK-061e)` · `- "error": "agent_scope"` / `+ "campaignId": …, "targetUsdc": "14080800000"`; restored.
- `pnpm --filter web test`: `Test Files  82 passed (82)` · `Tests  649 passed (649)`.
- Local `next build` + one-off uncommitted Playwright spec driving the real `reviewCampaignQueue` (fake classifier), `--workers=1`: both widths `✓` — `OK review campaign: approved "Reading corners for a village library chromium-x-x" (checks + fake-review-model: pass)`, `crew: APPROVED reviewer is staff: true | person: PENDING_REVIEW null`, `audit note: "Staff agent (TASK-061e): deterministic checks passed; classifier fake-review-model: pass"`, `model got cover: true title: true`; `2 passed (10.5s)`. First attempt (parallel workers): `held … cover could not be read (cover: download answered 403)` — the test uploaded covers without the `public-read` ACL; fail closed as written; fixed in the test only.
- Screens (one-off spec, 1440 + 390): "Crew agent" row in "Campaign data"; the note field in the approve dialog — `2 passed (6.7s)`.
- E2E `campaign-review.spec.ts` + `admin-hidden.spec.ts` (incl. axe on the approve dialog with the new field): `10 passed (25.8s)`.
- lint / typecheck (all but contracts), `pnpm check:design`: clean.

### Independent review (read-only subagent)
- No HIGH. MEDIUM: goal read from the first "€" in the cell → only the goal as set (the part in brackets when converted), anchored, compared in cents (test "only the goal as set counts…"; break — whole cell parsed again: `× … only the goal as set counts, not the display-currency conversion in front of it` · `Tests  1 failed | 18 passed (19)`; restored → `Tests  108 passed (108)`).
- MEDIUM: holds counted toward the 3 decisions → approvals ≤ 3 and crew campaigns checked ≤ 6, counted apart.
- LOW fixed: "Crew agent" row read first (a person's campaign is not read further); try/catch per campaign (recorded, no screenshot, budget stop still ends the run); Approve button checked before the dialog; cover link pinned to `campaigns/<this campaign>/<name>.webp`, `maxRedirects: 0`.
- LOW left: a held campaign is classified again each run; organisation queue unchanged (holds still count there).
- Re-proof after the fixes (local `next build`, one-off spec, both widths): `OK campaign queue: 6 waiting; 1 approved and 2 held by the agent, 3 left for a person`, `crew: APPROVED | person: PENDING_REVIEW | note: "Staff agent (TASK-061e): deterministic checks passed; classifier fake-review-model: pass"`; `2 passed (11.4s)`. The two held ones were left over from the first (failed) proof attempt — the new campaign was approved past them.
- `pnpm --filter agents test`: `Tests  108 passed (108)`.

### Open questions / risks
- A held crew campaign is classified again on each run while it waits (LOW).
- The two live campaigns from run 45665462416 have model-written titles; a classifier hold on them is possible and would come to David as an `agent-hold` issue.

### Docs
Chapter 11 §10 (new) / §11, 09, 06 (campaign review row), 04 (campaign review rules).

### Live run and fix (2026-11-25)
- PR #252 merged by David; Deploy 45683369543 `completed success`.
- Crew run **45683594846** `completed success` (annotations): `staff | ✓ admin sign-in: role + authenticator code accepted · ✓ organisation queue: 0 waiting … · ✓ review campaign: held "Books and Reading Corners for a Small Village Library": The texts contradict each other: the goal field says €100 … · ✓ review campaign: held "Picture books and cushions for a children's reading corner": The stated goal (≈ $109.35 / €100) contradicts the st… · ✓ campaign queue: 2 waiting; 0 approved and 2 held by the agent, 0 left for a person`; `holds | 2 held; new issue(s) #3 #4`. Other agents: donation, pool give, share link, awkward checks ✓.
- Cause: `startCampaign` asked the model for "a modest goal of a few hundred euros" and picked the goal (€100/200/300) afterwards at random; the classifier also saw the display conversion "≈ $109.35 (€100)".
- Fix (`fix/agents-campaign-goal-in-story`): goal chosen first and given to the writer; `amountsMatchGoal` (only "€<goal>" may appear; other amounts, ranges, dollars, "hundred(s)/thousand(s)" → fixed text); `goalAsSet` for the classifier. `pnpm --filter agents test`: `Tests  110 passed (110)`. Deliberate break — amount check off: `× fundraiser texts (fundraiser.ts) > the story may name only the goal chosen before it …` · `Tests  1 failed | 6 passed (7)`; restored → `Tests  110 passed (110)`.
- Not re-proved against a local `next build`: the change is in text generation and in the JSON sent to the model, not in a browser step (`startCampaign`'s page steps are unchanged; only the goal is computed earlier).

## 061e part 2, step 2c — the staff agent publishes the crew's approved campaigns (2026-11-27)
Status: DONE (Live on dev — run 45976097377, 2026-11-27)

### What I implemented
- `apps/agents/src/staff-publish.ts` (new): `publishQueue` — after both review queues, Admin → Campaigns → "Approved — waiting to be published"; up to 10 opened; the "Crew agent" row read first (a person's campaign only counted); at most 2 publish attempts per run; "Publish on Polygon" pressed in the campaign's Publish panel (re-clicked only while nothing started); a campaign that already shows "Sent transaction" is only checked, never sent again; then one link wait for all (≤ 5 min, "Check status" every ~30 s) until the "On Polygon" section shows the contract address.
- Records: `publish campaign` (✓ sent / ✗ with the panel's error text or the first line of the error), `campaign on Polygon` (✓ live at <address>; ✓ "sent, not linked yet" when sent in this run; ✗ when sent in an earlier run and still not linked), `publish queue` summary.
- `apps/agents/src/policy.ts`: staff `createCampaign` only with a crew beneficiary and beneficiary type 0.
- `apps/agents/src/run.ts`: `review-submission` is a spending task → the staff wallet is topped up with POL (no USDC: `SPENDS_USDC` excludes staff).
- `apps/web/src/lib/campaigns/review.ts`: `assertAgentScope` extracted from `lockForReview`; `apps/web/src/lib/campaigns/publish.ts` `loadForPublish` (prepare + sent) calls it → 409 `agent_scope`; message `admin.campaigns.publish.errors.agent_scope`.
- `apps/agents/src/fundraiser.ts`: the writer is told to name no prices or costs per item (the goal is the only amount), so fewer model texts are thrown away for the fixed text (two identical "Warm kennels for the winter" campaigns in run 45961625027).

### Deviations
- Payout mode (`setPayoutMode`) not done: the policy already allows it for staff; left until a campaign needs milestones (small change first).

### Test results (this sandbox)
- `campaign-publish.test.ts` (Postgres): `Tests  7 passed (7)` (6 + 1 new "the staff agent publishes only the crew's demo campaigns of a demo organisation (agent_scope)"). Deliberate break — `assertAgentScope` call removed from `loadForPublish`: `× … (agent_scope)` · `- "error": "agent_scope"` / `+ "error": "contracts_unavailable"` · `Tests  1 failed | 6 passed (7)`; restored.
- `pnpm --filter agents test`: `Tests  110 passed (110)` (two new assertions in "keeps Operator calls to the staff agent"). Deliberate break — crew-beneficiary check off: `× signer policy > keeps Operator calls to the staff agent` · `- "ok": false` / `+ "ok": true` · `Tests  1 failed | 109 passed (110)`; restored.
- `pnpm --filter web test`: `Test Files  82 passed (82)` · `Tests  650 passed (650)`.
- Local `next build` + one-off uncommitted Playwright spec driving the real `publishQueue` (1440 px, `--workers=1`; APP_ENV=local has no contracts and no Privy, so the panel says "Wallet sign-in is not configured" and has no Publish button — sending is proven only live): `"Crew campaign not sent": the page says wallet sign-in is not configured here` (✗), `"Crew campaign sent earlier" live at 0xCdCDCdCdcdcdcdCdcDcDCdcDcDCdCdcdCdcDCDcD` (✓ — the spec flipped it to Live after 45 s), `3 approved; 1 tried, 0 sent by the agent, 1 checked from an earlier run, 1 left for a person`; no hash written to the unsent or the person's campaign; `1 passed (51.5s)`. First attempt failed: the spec's own DB update was never executed (a drizzle query runs only when awaited) — test fixed; the summary then said "1 sent" for a failed attempt → attempts and sends now counted apart. Deliberate break — `startedByAgent` always true: `"A person campaign": the page says wallet sign-in is not configured here` → `× … expect(byPath(personal)).toEqual([])`; restored, green again.
- lint / typecheck (web, agents), `pnpm check:design`: clean. Owner guide v1.19 PDF rebuilt (23 pages).

### Independent review (read-only subagent)
- No HIGH. Confirmed: no send loop (≤ 2 attempts, re-click only while idle, "Sent transaction" → check only, on-chain `DuplicateOffchainId` as last stop); scope correct on prepare and sent; `check` safe unscoped; the policy's tuple decode correct; the circular import `staff-review` ↔ `staff-publish` harmless in ESM (bindings used only inside functions).
- MEDIUM fixed: any status line after the flow counted as a send — also "mismatch", "indexer not available" and "Something went wrong". Now only the `onChain.not_found` line ("The campaign is not on Polygon yet …") counts as sent-not-linked.
- LOW fixed: empty address string counted as linked inside the flow (now truthy, as in `waitForLink`); a missing `.catch` on the first button's text; the queue opens up to 20 (it was cut at 10 before the crew filter); the "still not linked" detail names the possible causes.
- LOW left: after a timeout the runner moves on while the page's flow may still be between send and `/sent` — the hash would then not be stored, and the next run presses Publish again (the page's own checks — `campaigns(offchainId)`, `previous_pending` — stop a second send; at worst one reverted transaction of gas). A transaction reverted in an earlier run stays ✗ until a person sends it again. `OTHER_MONEY` also rejects "hundreds of children".
- Re-proved after the fixes (local `next build`, one-off spec): same three records, `1 passed (52.7s)`; `pnpm --filter agents test`: `Tests  110 passed (110)`.

### Docs
Chapter 11 §11 (new) / §12, intro and status legend; 09 (TASK-061 row); 06 (campaign publishing row, agents paragraph); 04 (publish routes: `agent_scope`); owner guide v1.19 (§8 "Publishing") + change log + PDF.

### Live run (2026-11-27)
- PR #255 merged (session), Deploy 45968086994 `completed success`.
- Crew run **45968322268** `completed failure` (annotations): staff `✓ review campaign: approved "Books and Supplies for a Neighborhood Reading Corner"`, `✓ … "Winter Reading Corner for Our Neighborhood Children"`, `✓ campaign queue: 2 waiting; 2 approved and 0 held`, then `✗ publish campaign: "Warm kennels for the winter": the publish flow did not finish within six minutes` (twice), `✓ publish queue: 10 approved; 2 tried, 0 sent by the agent, 0 checked from an earlier run, 6 left for a person`; reports issue #5. Fundraisers submitted two new campaigns with the model's text (the new prompt line held). Everything else ✓.
- The run log is in the artifact, which the sandbox cannot download; the annotation said nothing about where the page stood. `fix/agents-publish-diagnostics`: the timeout detail now names the button's step text, the wallet methods the page called since the press, any signed hash and the last page errors — the next run says where it stalls (no guess at a fix before that). PR #256 merged (session).
- Crew run **45972203242** (with #256): staff approved two more crew campaigns (`2 waiting; 2 approved and 0 held`), then both publish attempts again `did not finish within six minutes; the button says "PUBLISH ON POLYGON"; wallet calls (2): eth_accounts, eth_chainId; signed: nothing; page errors: none`. Cause (runner bug): `innerText` follows the CSS upper case of `.ch-btn`, so the case-sensitive idle check never matched — a disabled (Privy not ready yet) or not yet clicked button counted as "started", then the loop waited for an idle button that it could never recognise. The page never started the flow (no `wallet_switchEthereumChain`, nothing signed).
- Fix (`fix/agents-publish-button`): wait up to a minute for the button to be enabled (stop at once with "no connected wallet" if the panel says so), click, and count as started only when the button's accessible name changed (DOM text, not CSS case); idle check case-insensitive. Proof on a stand-in page (one-off `tsx` script, uncommitted: upper-case button, enabled after 4 s, the five step texts, then a status line): `ok {"ok":true,"detail":"The campaign is not on Polygon yet …"} clicks: 1 12.3 s` · `mismatch {"ok":false,"detail":"A campaign with this ID exists on Polygon but does not match the approved one."} clicks: 1 12.2 s`. No deliberate break of the old code on that page (it would wait the full six minutes; the two live runs are that break). `pnpm --filter agents test`: `Tests  110 passed (110)`. PR #257 merged (session).
- Crew run **45976097377** `completed success` (annotations): staff `✓ review campaign: approved "Warm Winter Meals for Neighbors in Need"`, `✓ … "Warm Winter Kits for Neighborhood Stray Cats"`, `✓ publish campaign: sent "Warm kennels for the winter" (The campaign is not on Polygon yet …)` ×2, `✓ campaign on Polygon: "Warm kennels for the winter" live at 0x1841864172dc0e6197Ae60d6F65F33cA9E0ACA59` (the second record was cut in the 900-character notice). Runner: `plan: default (unterminated JSON in the answer)` — the dispatcher's answer was cut off and the default plan used (left for later).

## 061e — real cover photos for crew campaigns (2026-11-27)
Status: DONE (Built; live proof with the next crew run)

David (12:34, looking at a published "Warm kennels" campaign with its "TEST DOCUMENT" cover): "tu bomo potem kreirali prave slike?" → FLUX.2 [pro] chosen (≈ $0.03 per image; the app's demo-cover default); David created a fal key (preset "API") and added it as `FAL_KEY` to the GitHub Environment `agents`.

### What I implemented
- `apps/agents/src/cover.ts` (new): `coverPrompt` (the admin demo covers' photo brief), `makeCover` — fal queue API (`POST https://queue.fal.run/fal-ai/flux-2-pro` with `image_size landscape_4_3`, `jpeg` → status polling every 3 s ≤ 120 s → result → download). Only https from `*.fal.media` / `storage.googleapis.com`, no key to the CDN, JPEG magic bytes, ≤ 5 MB. Errors are short and never contain the key.
- `apps/agents/src/fundraiser.ts`: the writer returns `scene` (checked one line, 20–200 characters; a bad one becomes "a small charity project: <title>", the text stays); `coverFor` — photo with `FAL_KEY`, else (or when fal fails) the drawn test cover; annotation `<agent> · cover` with the source.
- `apps/agents/src/run.ts` / `cli.ts`: `FAL_KEY` (crew flow only) in the redaction list; `.github/workflows/agents.yml`: `FAL_KEY` passed to the crew run step.
- `apps/agents/src/review.ts`: classifier rule — KYB documents still need "TEST DOCUMENT"; a cover may be a plain generated photo, held if it does not fit or shows readable text, logos or a recognisable face. (Without this change every photo cover would have been held for "not clearly marked as a test document".)

### Test results (this sandbox)
- `pnpm --filter agents test`: `Tests  113 passed (113)` (3 new in `test/cover.test.ts`: protocol + no key to the CDN; foreign host / http / non-JPEG / FAILED / timeout / 401 refused without naming the key; scene checks). Deliberate break — host pin off: `× cover photo (FLUX.2 [pro] on fal.ai) > refuses a picture from elsewhere …` · `Tests  1 failed | 112 passed (113)`; restored.
- `coverFor` in a real Chromium (one-off `tsx` script, uncommitted): `no key | drawn test cover (no FAL_KEY) | 32211 bytes, JPEG: true` · `fal ok | fal-ai/flux-2-pro photo: wooden dog kennels with fresh straw bedding … | 2003 bytes, JPEG: true | is the photo: true` · `fal down | drawn test cover (cover: submit: HTTP 503) | 32211 bytes, JPEG: true`.
- fal.ai itself is not reachable from the sandbox: the real call is proven only live.
- lint / typecheck (agents): clean.

### Independent review (read-only subagent)
- No HIGH; no path for the key to leak (redaction lists, fixed error texts, no header to the CDN, GitHub masking); protocol the same as the app's working `lib/demo/cover.ts`.
- MEDIUM fixed: one failed status poll gave up on a job fal already charges for → up to 3 failed polls are waited out (test + deliberate break: `pollErrors > 0` → `× … waits out up to three failed status polls …` · `Tests  1 failed | 113 passed (114)`; restored).
- MEDIUM fixed: the drawn fallback card is readable text and contradicted the new "readable text → hold" cover rule → the prompt now allows "a drawn card headed TEST DOCUMENT" explicitly; "any organisation document" instead of a list that could read as complete.
- LOW fixed: `Content-Length` checked before buffering the image; `fail()` narrows types; the file comment. LOW left: a new fal CDN host would mean constant fallback — the annotation names the host.
- After the fixes: `pnpm --filter agents test`: `Tests  114 passed (114)`; lint / typecheck clean.

### Docs
Chapter 11 §7 (start-campaign cover); 05 (`FAL_KEY` of the `agents` environment).

### Live run with real covers (2026-11-27)
- PR #259 merged (session). Crew run **45994270731**: `fundraiser-2 · cover: fal-ai/flux-2-pro photo: Stack of folded grey and green wool blankets on a wooden shelf in a community hall, soft daylight …` and `fundraiser-1 · cover: fal-ai/flux-2-pro photo: Low wooden shelves of colorful children's books …` — fal works from Actions. fundraiser-2 `✓ campaign submitted: "Warm Winter Blankets for Our Neighbourhood Shelter", goal €200`; staff approved one campaign ("Warm Winter Socks for Neighborhood Shelter Guests") and published two ("Books and Supplies for a Neighborhood Reading Corner", "Winter Reading Corner for Our Neighborhood Children" — the second linked by the page itself).
- ✗ `fundraiser-1 · campaign submitted: "Help Our Village Library Buy Books for Young Readers" not shown as in review` — the record said nothing more, and the draft would have blocked fundraiser-1 for good ("still a draft" → skipped every run). Most likely cause: the app's limit of 5 active campaigns per organisation (`too_many_active`) — fundraiser-1's organisation had reached it.
- Fix (`fix/agents-campaign-draft`): `submitDraft` — not in review → the form's error line (scoped to the form) + marked fields; the 5-campaign answer → ✓ "skipped — stays a draft" (no report); a draft left by an earlier run is opened and submitted again (cover added if missing; cap not spent). Local proof (`next build`, one-off uncommitted spec driving the real `submitDraft`, 1440 px): `noCover {"ok":false,"detail":"not shown as in review; the form says \"Add a cover image before you submit the campaign.\""}` · `good {"ok":true}` · `atLimit {"ok":true,"atLimit":true,"detail":"Your organisation already has 5 campaigns in review or running. Wait until one has ended."}` (status stayed `DRAFT`); `1 passed (1.3m)`. `pnpm --filter agents test`: `Tests  114 passed (114)`; lint / typecheck clean.

## 061 — dispatcher answer cut off (2026-11-27)
Status: DONE (Live on dev — PR #262)

Seen in run 45976097377: `plan: default (unterminated JSON in the answer)` — the dispatcher's nine-task plan was cut off at `max_tokens: 800` (the closing `]` never came) and the run fell back to the default plan.

### What I implemented
- `apps/agents/src/llm.ts`: `Answer.stopReason` (the API's `stop_reason`).
- `apps/agents/src/dispatcher.ts`: `DISPATCHER_MAX_TOKENS = 2_000` (was 800; the budget charges the limit up front — 2,000 of 2,000,000); notes "under 60 characters" (was 100) and "no text before or after the array, no code fence"; `stop_reason: "max_tokens"` → fallback with the reason `answer cut off at the output limit (2000 tokens)` instead of the vague JSON error.
- Left out: retrying the dispatcher with a higher limit (one more Opus call per run for a case the new limit should not reach; the default plan is a safe fallback).

### Test results (this sandbox)
- `pnpm --filter agents test`: `Tests  115 passed (115)` (1 new in `test/crew-run.test.ts`: request carries `max_tokens` 2000; a cut-off answer → default plan with the named reason).
- Deliberate break — the `max_tokens` check disabled: `- "answer cut off at the output limit (2000 tokens)"` / `+ "unterminated JSON in the answer"` · `Tests  1 failed | 114 passed (115)`; restored → `Tests  115 passed (115)`.
- lint / typecheck (agents): clean.

### Docs
Chapter 11 §6 step 2 (limit, cut-off reason; also corrected: at most 9 tasks, staff review in the default plan).

### Live run (2026-11-27)
- PR #262 merged by David (the session's merge was refused by the classifier). Crew run **46001735269**, all steps ✓: `✓ plan: dispatcher: donor-1 donate, pool-1 pool-give, donor-2 share-check, awkward-1 awkward-use, fundraiser-1 start-organisatio…` — the dispatcher's own plan, no fallback.
- Same run: staff `✓ publish campaign: sent "Warm Winter Meals for Neighbors in Need"` and `"Warm Winter Kits for Neighborhood Stray Cats"`; both fundraisers `✓ start campaign: skipped — … stays a draft: Your organisation already has 5 …`; donor-1 donated 1.0975 USDC, pool-1 gave 12 → 13 USDC, awkward-1 all checks ✓.
- Noticed: both fundraisers report the organisation name "LANTERN HILL READING FUND (TESTNET)" — each agent sees only its own organisations, so the writer gave both the same name from the same prompt (not an app bug). Parked: vary the writer's prompt per fundraiser.

## 061f part 1 — daily schedule (2026-11-27)
Status: DONE (Built; Live after the first scheduled run)

David agreed to a daily run on 2026-11-24; HANDOFF "Next" 5.

### What I implemented
- `.github/workflows/agents.yml`: `schedule: cron "17 5 * * *"` (crew, daily 05:17 UTC); every `inputs.flow` → `inputs.flow || 'crew'` (a scheduled run has no inputs; without this the crew-only secrets would be empty and `FLOW` blank).
- No new per-day cap: one organisation per fundraiser, the app's five active campaigns per organisation, ≤ 2 publishes per run and the run budget already bound a run (chapter 11 §12). Left out: a separate per-day cap table — a second run on the same day would be bounded by the same limits.

### Test results (this sandbox)
- `actionlint .github/workflows/agents.yml` (actionlint-py from pip): no output, exit 0.
- The schedule itself can only be proven on GitHub: first scheduled run expected 2026-11-28 05:17 UTC.

### Docs
Chapter 11 §4 (pointer) and new §12; 09 (TASK-061 row).

## 061f part 2 — public page "What the agents do" (2026-11-27)
Status: DONE (Built; Live after merge + Deploy)

David 2026-11-25: "da si ljudje lahko pogledajo, kaj agenti počnejo"; 2026-11-27: "kar nadaljuj".

### What I implemented
- `apps/web/src/lib/agents/activity.ts` (new): `loadAgentActivity(db, crew, limit)` — stats per crew member, totals, newest activity, from existing tables only (chapter 11 §13).
- `apps/web/src/app/[locale]/agents/page.tsx` (new): the page; 404 unless dev/local; `noindex`; exact USDC amounts.
- `apps/web/src/components/AppFooter.tsx`: "Testnet agents" link on dev/local only.
- `apps/web/messages/en.json`: `agentsPage.*`, `ui.nav.agents`.

### Deviations from the spec (and why)
- No runner-written table of runs: it would need a write path from Actions into the app (a new secret). The page links to the public Actions runs instead.
- No bug count: it lives in the private reports repository (not reachable by the app without a token).

### Test results (this sandbox)
- `pnpm --filter web test`: `Test Files  84 passed (84)` · `Tests  656 passed (656)` (6 new). lint, typecheck clean; `pnpm check:design`: "Design check passed — no violations found."
- Deliberate breaks, each restored:
  - `is_agent` filter removed → `× … counts each agent's work …` / `× … lists recent work …` · `Tests  2 failed | 1 passed (3)`;
  - pool gifts without `source = 'DIRECT'` → `expected { count: 2, usdc: 2000000n } to deeply equal { count: 1, usdc: 1000000n }`;
  - crew-owned filter on staff decisions removed → `expected 'real live' to be 'live one'` · `Tests  2 failed | 1 passed (3)`;
  - page gate and footer gate disabled → `× … is a 404 on uat`, `× … is a 404 on prod`, `expected [ Array(9) ] to not include '/agents'` · `Tests  3 failed (3)`.
- E2E (`next build` + `CI=1 pnpm exec playwright test e2e/agents-page.spec.ts --retries=0`): `2 passed (6.3s)` (1440 and 390), re-run after the review fixes.
- Screenshots 1440 / 390 with temporary rows for donor-1, donor-2, pool-1 (deleted afterwards): totals grid 4 + 4 / 2 per row, crew cards 3 / 1 per row, recent list, no overflow. Locally there is no block explorer, so wallets show as full addresses; on dev they are explorer links.

### Independent review (read-only subagent)
- MEDIUM fixed: staff decisions were filtered only by actor + action — a decision on a real person's campaign would have been counted, and its title shown once deployed. Now only crew-owned work (demo campaign started by an agent / application by an agent); test with a staff decision on a real person's campaign, published campaign and application.
- LOW fixed: title rule now `DEPLOYED` **and** on chain (the public rule), "live" count the same; separator " · " moved into the message; "test charities approved" added to the totals; unused `col.*` keys removed; tests for the uat/prod 404 and footer link added.
- LOW left: no index on `chain.pool_contribution.donor` (small table; an indexer schema change means a re-index); one user with two crew wallets would count under one (not possible with the registry today); `role="status"` on static notices kept for consistency with the other public pages.

### Docs
Chapter 11 §13 (new), §14; 04 (pages table); 09 (TASK-061 row).

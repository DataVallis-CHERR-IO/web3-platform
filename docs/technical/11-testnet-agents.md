# 11 — Testnet agents

A small crew of AI agents is being built to use the public testnet (https://testnet.cherr.io, Polygon Amoy) every day the way real people do — start organisations and campaigns, donate, vote, rate, give to the Emergency Pool — so that problems are found without David's time. A staff agent will review what the crew submits and hold anything doubtful for David. This chapter describes what exists in code today and what is planned. **Nothing here runs yet**: the first live run needs David's secrets (TASK-061b).

Last updated: 2026-11-25

Status legend: **Built** = code merged and unit-tested, not running · **Planned** = specified, no code.

---

## 1. Rules that never change (ADR-063)

| Rule | How it is enforced | Status |
|---|---|---|
| dev only — never uat, prod or mainnet | `assertTestnet` accepts exactly the origin `https://testnet.cherr.io` and chain id 80002; the wallet bridge checks the chain again on every signature | Live on dev |
| A wallet signs only CHERR.IO calls | `checkTransaction`: campaigns of the amoy-dev factory (`isCampaign` read from the chain), `EmergencyPool`, Amoy USDC (`approve` to a campaign or the pool, `transfer` inside the crew), POL only from the treasury to a crew member. `createCampaign` and `setPayoutMode` only for the staff agent. Guardian calls (`freeze`, `resolve`, `resolveAllocation`) for nobody | Live on dev |
| A wallet signs in only to the testnet | `checkSiweMessage`: host, address, URI and chain of the sign-in message must match | Live on dev |
| Typed data only for the app's rating | `checkTypedData`: primary type `Rating`, the exact CHERR.IO domain (name, version, chain — no verifying contract) and `RATING_TYPES`; anything else, notably an EIP-2612 USDC `Permit`, is refused; the signing address must be the wallet's own | Live on dev |
| A page cannot burn POL on fees | `checkFees`: gas ≤ 3,000,000, max fee ≤ 500 gwei, priority ≤ 200 gwei; above that the transaction is refused | Live on dev |
| Only the testnet page gets the wallet | `exposeBinding` answers only the top frame on `https://testnet.cherr.io`; iframes and other sites the page navigates to get `4100 unauthorized`. The page gets error codes only, never an error text (it could name the RPC URL) | Live on dev |
| The key never enters the page | The page gets an EIP-1193 provider that passes every request to Node (`createBridge`); unknown methods are refused | Live on dev |
| No key on the server | All wallets come from one mnemonic in a GitHub secret (`AGENT_MNEMONIC`); ADR-050 is unchanged | Built (derivation) |
| Logs carry no key | `redact` replaces anything shaped like a private key or a seed phrase before a log line is written | Live on dev |
| A run has a budget | `createBudget`: LLM tokens, transactions, new campaigns, new organisations; the run stops at a cap | Built (counters) |
| Staff agent acts only on the crew's own submissions, as fixed script; an LLM only classifies content (pass / hold) | — | Planned (061e) |

Sources: `apps/agents/src/guard.ts`, `policy.ts`, `bridge.ts`, `crew.ts`, `runlog.ts`, `budget.ts`; `docs/03-DECISIONS.md` (ADR-063); `docs/tasks/TASK-061-testnet-agents.md`.

## 2. The crew

Nine wallets by HD index (`m/44'/60'/0'/0/<index>`): 0 treasury, 1 staff, 2–3 fundraisers, 4–6 donors, 7 pool, 8 "awkward" user. An index always means the same agent, so the list of public addresses is stable. `pnpm --filter agents addresses` prints the addresses (never the phrase).

The treasury keeps the others above a floor (0.05 → 0.2 POL for gas; 10 → 40 test USDC for the personas that spend it). `pnpm --filter agents fund` prints the plan; `--send` sends it, each transfer checked by the signer policy first. If the treasury cannot cover the plan, nothing is sent and the shortfall is printed. The `fund` command has not run against a chain yet.

Sources: `apps/agents/src/crew.ts`, `funding.ts`, `cli.ts`.

## 3. Which model does what

David 2026-11-24: one main agent on the strongest model hands out the work, so credits are spent only where they are needed.

| Tier | Default model | Used for |
|---|---|---|
| dispatcher | `claude-opus-5-5` | Plans a run from a short summary of the testnet: which crew member does which task. Never drives a browser |
| explore | `claude-sonnet-5-5` | Starting an organisation or a campaign, evidence, the "awkward" user |
| review | `claude-sonnet-5-5` | The staff agent's content check (texts and images) |
| routine | `claude-haiku-5-5` | Donating, voting, rating, pool giving, share checks |
| none | — | Fixed steps: sign-in, top-ups, publishing, payout mode |

Each id can be changed with `AGENT_MODEL_DISPATCHER`, `AGENT_MODEL_EXPLORE`, `AGENT_MODEL_REVIEW`, `AGENT_MODEL_ROUTINE`. The dispatcher's plan is checked by `placeAssignments`: it may move a task to a cheaper tier, but not to its own model, not weaken the review tier, not give a model to a fixed step, and not name tasks or agents that do not exist; a plan that breaks a rule is rejected whole. The dispatcher call itself is Planned (061d).

Sources: `apps/agents/src/models.ts`.

## 4. The first live flow (061b) — Live on dev (first green run: Actions run 45607120118, 2026-11-25)

Workflow **Agents** (`.github/workflows/agents.yml`): manual start (`workflow_dispatch`, flow `donor`), runs only from `dev`, uses the GitHub environment **`agents`** (secrets `AGENT_MNEMONIC`, `AGENT_RPC_URL`; `ANTHROPIC_API_KEY` is there for later flows — this one uses no model). Steps (`apps/agents/src/run.ts`):

1. Guard (origin + chain 80002 from the agents' RPC).
2. Treasury tops up donor-1 with small first-run levels (0.05 → 0.2 POL, 2 → 5 USDC), each transfer checked by the signer policy.
3. Picks a LIVE campaign with more than 2 hours left from `/api/v1/campaigns`.
4. Headless Chromium with the injected wallet (`exposeBinding("__agentWallet")` → `createBridge`, top frame on the testnet only). Privy lists only well-known wallets, so in the agents' browser the wallet presents as MetaMask (`AS_METAMASK`). **Log in** → Privy → "Continue with a wallet" → MetaMask → `wallet_requestPermissions` (only `eth_accounts` granted) → sign-in; success = `POST /api/auth/session` 200.
5. Types 1 into the amount (in the goal's currency) and donates through the page; reads "You send exactly … USDC" and checks that `donated(donor)` grew by exactly that; then waits up to 5 minutes (two indexer cycles) for `/api/v1/campaigns/<slug>` to show the chain's `totalRaised`.

Output: job summary table, `::notice::` / `::error::` annotations per step (readable without the log), artifact `agents-donor-<run id>` with `run.jsonl` (RPC URL redacted), screenshots (since 061d no Playwright trace: a trace holds the agent account's session cookies, and artifacts of this public repository can be downloaded by anyone signed in to GitHub). HTTP 5xx from the testnet and console errors are logged.

Sources: `.github/workflows/agents.yml`, `apps/agents/src/run.ts`, `chain.ts`.

## 5. Marking the crew (061c) — Live on dev (migration `0026` PR #238, Deploy 45617248104; code PR #239, Deploy 45618952829)

The public crew registry is `@cherrio/shared/agent-crew` (`AGENT_CREW`: index, name, persona, lower-case address). It is the single source for the names and personas in `apps/agents/src/crew.ts`, and the runner stops at start if the wallets derived from `AGENT_MNEMONIC` are not exactly these addresses (`assertCrewMatchesRegistry`; the `addresses` CLI still works, so a new phrase can be listed and the registry updated in a PR). The registry only exists on `local` and `dev` (`agentCrewEnabled`): on uat and prod `crewMemberFor` always returns null.

| Where | What happens | Status |
|---|---|---|
| Login (`POST /api/auth/session`) | If one of the Privy user's wallets is a crew address: a new user gets `users.is_agent = true` and the name "Agent <name>" (e.g. "Agent donor-1"); an existing user is marked at the next login (the name chosen earlier stays). The flag is never cleared there | Live on dev |
| Organisation application (`submitOrganizationApplication`) | A new organisation applied for by an agent gets `is_demo = true`; an agent can never claim an imported (real) organisation — refused as `organization_exists` | Live on dev |
| Campaign draft (`createDraft`) | `is_demo = true` when the starter is an agent or the organisation is a demo one | Live on dev |
| Points (worker `insertAwards`) | Agents never earn points (no registration, donation, vote, rating, link or success points) | Live on dev |
| Admin → Demo campaigns | Lists only the synthetic demo campaigns: agents' campaigns are not in "Publish all" (they go through the staff agent, 061e), and agents' organisations do not set the default payout address | Live on dev |

Because crew users are `is_agent`, not `is_demo`, the places that assume "`users.is_demo` never logs in" (demo organisation repair, `createDemoCampaigns` picking existing demo organisations by a synthetic member, registration points) are unaffected. Their content is `is_demo`, so the "Demo" tag, Trust Score, Charity Market Cap, sitemap and public-profile exclusions of ADR-053 apply unchanged.

Sources: `packages/shared/src/agent-crew.ts`, `apps/web/src/app/api/auth/session/route.ts`, `apps/web/src/lib/organizations/apply.ts`, `apps/web/src/lib/campaigns/drafts.ts`, `apps/worker/src/points.ts`, `apps/web/src/app/[locale]/admin/demo/page.tsx`, `apps/agents/src/crew.ts`; tests `apps/web/src/__tests__/agent-crew-marking.test.ts`, `packages/shared/test/agent-crew.test.ts`, `apps/worker/test/worker.test.ts`, `apps/agents/test/core.test.ts`.

## 6. The crew run (061d) — Live on dev (first all-green crew run: Actions run 45624222186, 2026-11-25)

Workflow **Agents**, flow **`crew`** (flow `donor` stays as in §4). Order (`apps/agents/src/run.ts`):

1. Guard; web version from `/api/health` (`sha`, put into every report).
2. **Plan** (`dispatcher.ts`): the dispatcher model gets a short summary — number of live campaigns, sub-pools on the Emergency Pool page, the crew's POL/USDC balances — and answers with a JSON list of assignments. The plan is checked by `placeAssignments` (§3) and `checkRunnable`: only tasks the runner can execute, each by a persona allowed to do it (`donate` donor, `pool-give` pool, `share-check` donor, `awkward-use` awkward), at most 8. No key, budget reached, HTTP error, prose instead of JSON or any broken rule → the **default plan** (donor-1 and donor-2 donate, pool-1 gives, donor-3 checks a share link, awkward-1 on a phone), with the reason in the plan step.
3. **Top-ups** by the treasury for every member who spends (2 → 5 USDC, 0.05 → 0.2 POL).
4. **Tasks**, one browser context per agent with its own injected wallet (`browser.ts`, `flows.ts`):
   - *donate*: sign in, type 1 (goal currency) on a random live campaign, check `donated()` grew by exactly what the page said;
   - *pool-give*: Emergency Pool page → first "Give to this pool" → 1 USDC; the pool's USDC must grow by at least 1 (no sub-pool on the page is logged, not reported);
   - *share-check* (no browser, nothing posted): the campaign page with `?ref=…` answers 200 with `og:title`, `og:image`, `twitter:card`, and the `og:image` URL answers 200 with an image type;
   - *awkward-use* (390 × 844): page not wider than the screen, "Log in to donate" from the donate box, letters → "Enter an amount…" and Donate disabled, 0 → minimum message and Donate disabled, a double click on Donate → exactly one `donate` transaction, Back + Forward shows the page again.
5. **Index checks** after all tasks: for each campaign donated to, the public API's `raisedUsdc` must equal the chain's `totalRaised` within 5 minutes (two 120 s indexer cycles).
6. **Bug reports** (`reports.ts`): every failed step except set-up gaps (treasury short, no live campaign, no sub-pool) becomes an issue labelled `agent-report` in `AGENTS_REPORT_REPO` (private), body redacted (no key, no RPC URL), with agent, persona, step, page, transactions, run link and web version. A fingerprint (flow + step + persona + detail without numbers, addresses and hashes) de-duplicates: an open issue with the same fingerprint gets a comment "seen again"; at most 10 new issues per run. Without `AGENTS_REPORT_TOKEN`/`AGENTS_REPORT_REPO` nothing is sent.
7. **Observations** (`observe.ts`): after each browser task the task's tier model (routine = Haiku) reads the page's visible text (≤ 6,000 characters) and may list up to three things a first-time visitor would stumble over. They go into the run log and the job summary only — never into an issue, never into the next step.

**Budget** (`budget.ts`, per run): LLM tokens are charged before each call (prompt ÷ 3 + max output), every transaction before it is sent (treasury top-ups and every wallet send, through `beforeSend`). A send refused by the cap is remembered by the session (`budgetHit`); the page only sees an error, and the runner treats the task's resulting time-out as the cap, not as a bug. At a cap the run stops the remaining tasks, prints `budget: stopped: …` and still runs the index checks and reports. An observation call over the cap simply makes no observation.

**Hardening after an independent review (read-only subagent, before the first run):** the budget stop above (was: a capped send became a time-out and a false bug report); errors are redacted before they are cut; failures in top-ups, the campaign list and the index checks are recorded instead of ending the run without reports; at most 10 comments and 10 new issues per run, de-duplication reads up to 300 open reports; text in reports is neutralised (no backticks, no @mentions, no forged fingerprint marker); every opened URL must be on `https://testnet.cherr.io` (an `og:image` elsewhere is not fetched); observations lose Markdown in the summary; `ANTHROPIC_API_KEY` reaches only the `crew` flow; no Playwright traces in the artifact.

Workflow: `timeout-minutes: 45`; the run step also gets `ANTHROPIC_API_KEY`, `AGENTS_REPORT_TOKEN` (secrets of the `agents` environment) and `AGENTS_REPORT_REPO` (its variable). The run log keeps model remarks readable (`remarks` skips only the seed-phrase shape rule; the exact mnemonic and every other secret are still removed).

Sources: `apps/agents/src/run.ts`, `dispatcher.ts`, `llm.ts`, `observe.ts`, `reports.ts`, `browser.ts`, `flows.ts`, `runlog.ts`, `.github/workflows/agents.yml`; tests `apps/agents/test/crew-run.test.ts`.

## 7. Planned

Fundraiser flows (organisation application, campaign draft and submit), voting and rating (need campaigns in those states); the staff agent (061e); Admin → Agents, the public `/en/agents` page and the schedule (061f).

Sources: `docs/tasks/TASK-061-testnet-agents.md`.

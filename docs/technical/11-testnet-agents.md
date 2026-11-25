# 11 — Testnet agents

A small crew of AI agents is being built to use the public testnet (https://testnet.cherr.io, Polygon Amoy) every day the way real people do — start organisations and campaigns, donate, vote, rate, give to the Emergency Pool — so that problems are found without David's time. A staff agent will review what the crew submits and hold anything doubtful for David. This chapter describes what exists in code today and what is planned. **Nothing here runs yet**: the first live run needs David's secrets (TASK-061b).

Last updated: 2026-11-25

Status legend: **Built** = code merged and unit-tested, not running · **Planned** = specified, no code.

---

## 1. Rules that never change (ADR-063)

| Rule | How it is enforced | Status |
|---|---|---|
| dev only — never uat, prod or mainnet | `assertTestnet` accepts exactly the origin `https://testnet.cherr.io` and chain id 80002; the wallet bridge checks the chain again on every signature | Built |
| A wallet signs only CHERR.IO calls | `checkTransaction`: campaigns of the amoy-dev factory (`isCampaign` read from the chain), `EmergencyPool`, Amoy USDC (`approve` to a campaign or the pool, `transfer` inside the crew), POL only from the treasury to a crew member. `createCampaign` and `setPayoutMode` only for the staff agent. Guardian calls (`freeze`, `resolve`, `resolveAllocation`) for nobody | Built |
| A wallet signs in only to the testnet | `checkSiweMessage`: host, address, URI and chain of the sign-in message must match | Built |
| Typed data only for the app's rating | `checkTypedData`: primary type `Rating`, the exact CHERR.IO domain (name, version, chain — no verifying contract) and `RATING_TYPES`; anything else, notably an EIP-2612 USDC `Permit`, is refused; the signing address must be the wallet's own | Built |
| A page cannot burn POL on fees | `checkFees`: gas ≤ 3,000,000, max fee ≤ 500 gwei, priority ≤ 200 gwei; above that the transaction is refused | Built |
| Only the testnet page gets the wallet | `exposeBinding` answers only the top frame on `https://testnet.cherr.io`; iframes and other sites the page navigates to get `4100 unauthorized`. The page gets error codes only, never an error text (it could name the RPC URL) | Built |
| The key never enters the page | The page gets an EIP-1193 provider that passes every request to Node (`createBridge`); unknown methods are refused | Built |
| No key on the server | All wallets come from one mnemonic in a GitHub secret (`AGENT_MNEMONIC`); ADR-050 is unchanged | Built (derivation) |
| Logs carry no key | `redact` replaces anything shaped like a private key or a seed phrase before a log line is written | Built |
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

Output: job summary table, `::notice::` / `::error::` annotations per step (readable without the log), artifact `agents-donor-<run id>` with `run.jsonl` (RPC URL redacted), screenshots and a Playwright trace. HTTP 5xx from the testnet and console errors are logged.

Sources: `.github/workflows/agents.yml`, `apps/agents/src/run.ts`, `chain.ts`.

## 5. Marking the crew (061c) — Built (migration `0026` merged separately first; code waits for its Deploy)

The public crew registry is `@cherrio/shared/agent-crew` (`AGENT_CREW`: index, name, persona, lower-case address). It is the single source for the names and personas in `apps/agents/src/crew.ts`, and the runner stops at start if the wallets derived from `AGENT_MNEMONIC` are not exactly these addresses (`assertCrewMatchesRegistry`; the `addresses` CLI still works, so a new phrase can be listed and the registry updated in a PR). The registry only exists on `local` and `dev` (`agentCrewEnabled`): on uat and prod `crewMemberFor` always returns null.

| Where | What happens | Status |
|---|---|---|
| Login (`POST /api/auth/session`) | If one of the Privy user's wallets is a crew address: a new user gets `users.is_agent = true` and the name "Agent <name>" (e.g. "Agent donor-1"); an existing user is marked at the next login (the name chosen earlier stays). The flag is never cleared there | Built |
| Organisation application (`submitOrganizationApplication`) | A new organisation applied for by an agent gets `is_demo = true`; an agent can never claim an imported (real) organisation — refused as `organization_exists` | Built |
| Campaign draft (`createDraft`) | `is_demo = true` when the starter is an agent or the organisation is a demo one | Built |
| Points (worker `insertAwards`) | Agents never earn points (no registration, donation, vote, rating, link or success points) | Built |
| Admin → Demo campaigns | Lists only the synthetic demo campaigns: agents' campaigns are not in "Publish all" (they go through the staff agent, 061e), and agents' organisations do not set the default payout address | Built |

Because crew users are `is_agent`, not `is_demo`, the places that assume "`users.is_demo` never logs in" (demo organisation repair, `createDemoCampaigns` picking existing demo organisations by a synthetic member, registration points) are unaffected. Their content is `is_demo`, so the "Demo" tag, Trust Score, Charity Market Cap, sitemap and public-profile exclusions of ADR-053 apply unchanged.

Sources: `packages/shared/src/agent-crew.ts`, `apps/web/src/app/api/auth/session/route.ts`, `apps/web/src/lib/organizations/apply.ts`, `apps/web/src/lib/campaigns/drafts.ts`, `apps/worker/src/points.ts`, `apps/web/src/app/[locale]/admin/demo/page.tsx`, `apps/agents/src/crew.ts`; tests `apps/web/src/__tests__/agent-crew-marking.test.ts`, `packages/shared/test/agent-crew.test.ts`, `apps/worker/test/worker.test.ts`, `apps/agents/test/core.test.ts`.

## 6. Planned

Personas, UI-against-chain checks and bug reports as GitHub Issues (061d); the staff agent (061e); Admin → Agents and the schedule (061f).

Sources: `docs/tasks/TASK-061-testnet-agents.md`.

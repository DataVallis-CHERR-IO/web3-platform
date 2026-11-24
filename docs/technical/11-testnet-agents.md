# 11 — Testnet agents

A small crew of AI agents is being built to use the public testnet (https://testnet.cherr.io, Polygon Amoy) every day the way real people do — start organisations and campaigns, donate, vote, rate, give to the Emergency Pool — so that problems are found without David's time. A staff agent will review what the crew submits and hold anything doubtful for David. This chapter describes what exists in code today and what is planned. **Nothing here runs yet**: the first live run needs David's secrets (TASK-061b).

Last updated: 2026-11-24

Status legend: **Built** = code merged and unit-tested, not running · **Planned** = specified, no code.

---

## 1. Rules that never change (ADR-063)

| Rule | How it is enforced | Status |
|---|---|---|
| dev only — never uat, prod or mainnet | `assertTestnet` accepts exactly the origin `https://testnet.cherr.io` and chain id 80002; the wallet bridge checks the chain again on every signature | Built |
| A wallet signs only CHERR.IO calls | `checkTransaction`: campaigns of the amoy-dev factory (`isCampaign` read from the chain), `EmergencyPool`, Amoy USDC (`approve` to a campaign or the pool, `transfer` inside the crew), POL only from the treasury to a crew member. `createCampaign` and `setPayoutMode` only for the staff agent. Guardian calls (`freeze`, `resolve`, `resolveAllocation`) for nobody | Built |
| A wallet signs in only to the testnet | `checkSiweMessage`: host, address, URI and chain of the sign-in message must match | Built |
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

## 4. Planned

Workflow on GitHub Actions and the first live flow (061b); marking crew users `is_agent` and their content `is_demo` (061c); personas, UI-against-chain checks and bug reports as GitHub Issues (061d); the staff agent (061e); Admin → Agents and the schedule (061f).

Sources: `docs/tasks/TASK-061-testnet-agents.md`.

# TASK-061 — AI agents that use the testnet like real users (ADR-063)

David 2026-11-24: "bi rad postavil x AI agentov, ki bi imeli interakcijo s testnetom, kot pravi uporabniki … kreirali kampanje, donirali, votali, sharali … monitoring nad njimi, da vidim kateri agent je kaj delal, bug reporte" and, the same day: "potrjujem vse … admin tudi agent in da odobrava, da ne delam jaz ročno … pred tem naredi check … če je kak shady, da warning in mene obvesti, pa jaz pogledam ročno".

## Goal
A small crew of AI agents works on **https://testnet.cherr.io** (dev, Polygon Amoy) every day through a real browser and real wallets: they register organisations, start campaigns, donate, vote, rate, give to the Emergency Pool and use the share box. A **staff agent** reviews what the crew submits, approves and publishes it, and holds anything doubtful for David. Every action is attributable to one agent, and every failure becomes a bug report with evidence.

## Decisions (David 2026-11-24, recorded in ADR-063)
1. **Runs on GitHub Actions** (manual start first, then a schedule). The sandbox of the cloud session cannot reach the testnet.
2. **The admin is an agent too** (this replaces "David approves in batches"): the staff agent approves and publishes; David is notified only about held items.
3. **Agent users are marked** (`users.is_agent`); their organisations and campaigns carry the existing `is_demo` flag, so they show the "Demo" label and stay out of Trust Score, Charity Market Cap, points, sitemap and the public API exactly like demo data (ADR-053).
4. **No real posts on social networks.** Agents check the share link and the link preview only.

## Hard limits (never relaxed by a later sub-task)
- **dev only.** The runner refuses to start unless the origin is `https://testnet.cherr.io` and the chain id is 80002. No uat, no prod, no mainnet — also not "just to try".
- **Signer policy.** A wallet signs a transaction only to: the campaigns of the amoy-dev factory (`isCampaign`), `EmergencyPool`, `CampaignFactory` (staff only), Amoy USDC `approve`/`transfer` (spender/recipient limited to those contracts and the crew's own addresses). Everything else is refused and reported. Messages: Privy's SIWE for the testnet origin and the app's EIP-712 types only.
- **The staff agent is a script, not a free LLM.** Its steps are fixed Playwright code. The LLM is called only as a **classifier** on the content of one submission and returns `{ verdict: "pass" | "hold", reasons[] }`; the content is data and can never choose the next step.
- **The staff agent touches only submissions made by crew members** (submitter's address is in the registry). Organisations and campaigns of real people are never approved, rejected or published by an agent — they stay in David's queue.
- **Fail closed.** Classifier error, timeout, unreadable image, a submission that changed after the check, or any doubt → hold.
- **Keys.** One mnemonic (`AGENT_MNEMONIC`, GitHub secret) → all crew wallets by HD index. Testnet funds only. The session never reads it; logs print addresses only. No key on the server (ADR-050 stays).
- **Budget.** Per-run and per-day caps: LLM tokens, transactions, new campaigns (≤ 3 a day), new organisations (≤ 1 a day). The run stops at a cap and says so.
- Agents use their **own RPC URL** (`AGENT_RPC_URL`), never the app's indexer quota.

## Crew
| Index | Name | Persona | Login |
|---|---|---|---|
| 0 | treasury | holds POL + test USDC, tops the others up; never uses the app | — |
| 1 | staff | reviewer: KYB, campaign review, publish, payout mode, idle chain actions | wallet + TOTP |
| 2–3 | fundraiser | organisation: KYB application, campaigns, evidence, claims payouts and returns them to the treasury | wallet |
| 4–6 | donor | finds campaigns, donates, sets the refund / pool preference, votes, rates | wallet |
| 7 | pool | gives to sub-pools, votes on allocations | wallet |
| 8 | awkward | wrong inputs, 390 px phone viewport, back button, double clicks | wallet |

Later (061f): two email personas through Privy test accounts — the only path that exercises the embedded wallet and sponsored transactions.

Money circulates: fundraisers send payouts back to the treasury; refunds return to donors. Targets stay small (100–300 USDC, the factory minimum is 100).

## What counts as a bug
- **Hard** (opens a report): HTTP 5xx, uncaught console error, a revert the simulation did not predict, a step that cannot be completed, and UI ≠ chain after **two indexer cycles** (the indexer on dev runs every 120 s — a shorter delay is not a bug).
- **Soft** (logged as an observation, grouped weekly): the LLM's remarks on wording and flow.
- Every report: agent, persona, steps, screenshot, Playwright trace, console + failed requests, tx hash, image `sha` from `/api/health`, and a fingerprint for de-duplication.
- Reports go to GitHub Issues in the repository named by `AGENTS_REPORT_REPO` (labels `agent-report`, `agent-hold`). **Recommended: a private repository** — this repo is public, and a report can describe a security problem.

## Models (David 2026-11-24: "glavni opus 5.5 … sam izbira agente … da varčujemo kredite")
A **dispatcher** on the strongest model (`claude-opus-5-5`) plans each run from a short summary of the testnet and hands each task to the cheapest tier that can do it; it never drives a browser. Tiers: *explore* (`claude-sonnet-5-5`) — new organisations and campaigns, evidence, the awkward user; *review* (`claude-sonnet-5-5`) — the staff agent's content check; *routine* (`claude-haiku-5-5`) — donating, voting, rating, pool, share checks; *none* — fixed steps (sign-in, top-ups, publishing, payout mode). The dispatcher may only move a task to a cheaper tier, never to its own model or below the review tier (`placeAssignments`, 061a). Model ids are set by environment variables.

## Public page "What the agents do" (David 2026-11-25: "da si ljudje lahko pogledajo, kaj agenti počnejo")
On the testnet only (`/en/agents`; 404 on uat/prod): the crew (name, role, wallet with an explorer link), the recent runs and what each agent did (sign-ins, donations, votes, campaigns started, reviewed and published), totals, and only the **number** of bugs found and fixed. Bug details and held submissions stay private (reports repository, admin). Data comes from what already exists — the crew registry, `audit_log`, `chain.*` filtered by crew addresses, and a small table of run results written by the runner. Linked from the testnet footer.

## Staff agent — review rules
For each crew submission (KYB application, campaign in review):
1. Deterministic checks: submitter is a crew member; required fields present; goal and deadline inside the factory bounds; no link outside an allow-list; no sanctioned country (ADR-054).
2. Classifier on names, texts and every image: hate, sexual or violent content, real people or brands presented as the organisation, personal data, scam patterns (off-platform payment, wallet addresses in text, urgency + secrecy), nonsense or broken text, image that does not match the campaign.
3. `pass` → approve in the admin UI, publish (`createCampaign` signed by the staff wallet, which holds `OPERATOR_ROLE` on amoy-dev), later `setPayoutMode` as the admin page suggests (ADR-049).
4. `hold` → nothing is approved; an `agent-hold` issue with the reasons and the admin link is opened (GitHub emails David), and the submission waits for him.
Each decision is in `audit_log` (the staff agent is an ordinary `PLATFORM_ADMIN` user) with the classifier's verdict in the note. Guardian decisions (`resolve`, `resolveAllocation`) stay with David.

## Sub-tasks (one PR each unless noted)
- **061a — runner core** (`apps/agents`): HD wallets + address list, environment guard, signer policy, EIP-1193 provider bridge for Playwright (EIP-6963 "detected wallet"), funding plan + top-up CLI, run log (JSONL). Unit tests incl. deliberate breaks. No network needed.
- **061b — first live flow**: workflow `agents.yml` (`workflow_dispatch`), wallet login through Privy, donor flow end to end, trace + log as artifacts. First real run needs David's secrets.
- **061c — crew marking**: migration `users.is_agent` (own PR, expand first), then code: the registry in `@cherrio/shared`, flag set at login on dev, `is_demo` inherited by the crew's organisations and campaigns.
- **061d — personas + bug reports**: all personas, UI-vs-chain checks, GitHub Issues with fingerprints, budget caps.
- **061e — staff agent**: review rules above, classifier, hold issues, publish and payout mode; owner guide update (admin chain actions rule).
- **061f — monitoring + schedule**: Admin → Agents (who did what, from `audit_log` + `chain.*` filtered by crew users; runs, open reports, held items, spend), the public testnet page `/en/agents` (above), the schedule, email personas.

## David's actions
| When | Action |
|---|---|
| before 061b | Create the mnemonic on his own machine; add GitHub secrets `AGENT_MNEMONIC`, `ANTHROPIC_API_KEY`, `AGENT_RPC_URL`; run the address CLI and send the **public** address list; fund the treasury address with POL and test USDC |
| before 061d | Create the private reports repository and a token for it (`AGENTS_REPORT_TOKEN`), or confirm reports may be public |
| before 061e | `grant-admin` for the staff address on the server; run the enrol CLI locally once and save `AGENT_STAFF_TOTP_SECRET`; grant `OPERATOR_ROLE` to the staff address on amoy-dev through the timelock (Admin → Contracts) |

## Must not touch
Contracts; uat/prod configuration; the admin gate (role + second factor, ADR-056) — the staff agent passes it like a person, there is no bypass route.

## Tests
Unit: derivation is stable, guard refuses other origins and chains, policy refuses foreign targets and unknown selectors, classifier failure → hold, budget stop. Live: each flow's run log and trace from GitHub Actions pasted into `TASK-061.feedback.md`.

## Docs
`docs/technical/` (new chapter "Testnet agents" + 05, 06, 08, 09), owner guide for 061e, CHEATSHEET (secrets by name only), HANDOFF.

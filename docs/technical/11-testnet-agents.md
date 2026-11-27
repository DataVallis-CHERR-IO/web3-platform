# 11 — Testnet agents

A small crew of AI agents is being built to use the public testnet (https://testnet.cherr.io, Polygon Amoy) every day the way real people do — start organisations and campaigns, donate, vote, rate, give to the Emergency Pool — so that problems are found without David's time. A staff agent will review what the crew submits and hold anything doubtful for David. This chapter describes what exists in code today and what is planned; each section carries its own status (the crew has run on dev since 2026-11-25).

Last updated: 2026-11-27

Status legend: **Live on dev** = running against https://testnet.cherr.io · **Built** = code merged and unit-tested, not running · **Planned** = specified, no code.

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
| Staff agent acts only on the crew's own submissions, as fixed script; an LLM only classifies content (pass / hold) | — | Planned (061e); its admin authenticator is Built (§8) |

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
2. **Plan** (`dispatcher.ts`): the dispatcher model gets a short summary — number of live campaigns, sub-pools on the Emergency Pool page, the crew's POL/USDC balances — and answers with a JSON list of assignments. The plan is checked by `placeAssignments` (§3) and `checkRunnable`: only tasks the runner can execute, each by a persona allowed to do it (`donate` donor, `pool-give` pool, `share-check` donor, `awkward-use` awkward, `start-organisation` / `start-campaign` fundraiser — §7), at most 8. No key, budget reached, HTTP error, prose instead of JSON or any broken rule → the **default plan** (donor-1 and donor-2 donate, pool-1 gives, donor-3 checks a share link, awkward-1 on a phone, both fundraisers start an organisation, fundraiser-1 a campaign), with the reason in the plan step.
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

## 7. Fundraisers (061e, part 1) — Live on dev (PR #246; first run 45642806416, 2026-11-25)

Two tasks for the fundraiser persona (fundraiser-1, fundraiser-2), both on the *explore* tier (`apps/agents/src/fundraiser.ts`). They sign no transaction — the application and the campaign draft are off-chain — so no top-up is needed.

- **start-organisation**: sign in → `/en/account/organization`. If an application is already *Waiting for review* or *Verified*, the task stops with "skipped" (one in flight per fundraiser). Otherwise: the form at `/en/organizations/new` with country Slovenia, register "Not in any of these registers", one cause, the fundraiser's **own wallet as payout address** (payouts go back to the treasury later), and two KYB files the browser draws itself — a PDF register extract and a PNG authorisation, each headed "TEST DOCUMENT — CHERR.IO TESTNET" with the organisation and the applicant's wallet. Pass = the application shows *Waiting for review*.
- **start-campaign**: sign in → `/en/account/campaigns`. "Only a verified organisation can start a campaign." → skipped (the organisation waits for review); a campaign *Waiting for review* → skipped; a *Draft* left by an earlier run → opened and submitted again (cover added if missing; no new text, the cap is not spent). When the app answers "Your organisation already has 5 campaigns in review or running" (`MAX_ACTIVE_CAMPAIGNS_PER_ORG`, `too_many_active`) the draft stays and the step is ✓ "skipped" — the app's limit working, which also stops the crew from piling up campaigns until some end; any other refusal is ✗ with the form's own error line and the marked fields. Otherwise: draft with title, story, cause, Slovenia, goal **€100, €200 or €300**, 21 days → Save draft → the cover → Submit for review. **Cover (since 2026-11-27, Built):** with the run secret `FAL_KEY` (environment `agents`, crew flow only) a real photo from **FLUX.2 [pro]** on fal.ai (`apps/agents/src/cover.ts`: queue API submit → status → result, image downloaded only from fal's CDN without the key, JPEG ≤ 5 MB, ≤ 2 minutes; about $0.03 per image, ≤ 2 per run). The prompt is the same photo brief as the admin's demo covers (documentary look, no text, no logos, no identifiable faces) around a one-line `scene` the writer returns with the text (20–200 characters, one line, no links/numbers — otherwise "a small charity project: <title>"; a bad scene never throws the text away). Without the key, or when fal fails, the old 1200 × 800 "TEST DOCUMENT" JPEG drawn by the browser; the annotation `<agent> · cover` names which and why. The staff classifier's rule changed with it: KYB documents must still be marked "TEST DOCUMENT"; a campaign cover may be a plain generated photo of the project, and is held if it does not fit the campaign or shows readable text, logos or a recognisable face. Pass = "Our team is checking your campaign".
- **Texts**: the task's model (Sonnet) writes the name and description or the title and story as JSON. The answer is data: lengths are checked, and a text with a link, e-mail, wallet address or a long number (account, phone) is refused; then a fixed text is used (also without a key or on a model error), and the run log says which source was used. The runner — not the model — adds " (testnet)" to the organisation name and the line "Created by the CHERR.IO testnet agent <name>. This is not a real organisation/campaign." to every description and story. The app marks the crew's organisations and campaigns demo (§5).
- **Limits**: at most one new organisation and three new campaigns per run (`budget.ts`); a reached cap skips only that task (the others go on). With one in flight per fundraiser there are never more than two waiting applications and two waiting campaigns.
- **Until the staff agent exists** the crew's applications and campaigns wait in the ordinary admin queues (Admin → Organisations / Campaigns), marked as the crew's (demo). David may approve them by hand; then start-campaign continues on the next run.

First run (45642806416, all green): fundraiser-1's organisation "Lantern Hill Reading Fund (testnet)" — text from `claude-sonnet-5-5` — is waiting for review; fundraiser-2's application was skipped by the run cap (organisations 1); both start-campaign tasks skipped (organisation not verified yet).

Sources: `apps/agents/src/fundraiser.ts`, `dispatcher.ts` (`RUNNABLE`, default plan now 8 tasks), `run.ts`; tests `apps/agents/test/fundraiser.test.ts`; Actions run 45642806416.

## 8. Staff agent — admin authenticator (061e, part 2, step 1) — Live on dev (PR #248; enrolled on https://testnet.cherr.io 2026-11-25)

The staff agent (crew index 1, `0x31e7…3e28`) is an ordinary `PLATFORM_ADMIN` user and passes the admin gate like a person: role + a 6-digit authenticator code (ADR-056). There is no bypass route. Its authenticator is a TOTP key stored as the GitHub secret **`AGENT_STAFF_TOTP_SECRET`** (environment `agents`); the runner computes the codes itself.

| Part | What it does | Status |
|---|---|---|
| `staff.ts` — codes | RFC 6238 TOTP with the gate's parameters (SHA-1, 6 digits, 30 s), repeated in `apps/agents` because agents never import `apps/web`; pinned by the RFC 6238 test vectors. Each code works once, so after the enrolment code the agent waits for the next 30-second step before passing the code screen | Built |
| `staff.ts` — gate | `adminGate` opens `/en/admin` and tells the screen: 404 = not an admin yet; "Set up your authenticator"; "Confirm it is you"; or open (the "Admin menu" navigation, present on every admin page). `enrolSecondFactor` does the enrolment as a person would (show key → type code → ten recovery codes → continue; the button is clicked again if the page was not hydrated yet). `passSecondFactor` types the current code | Built |
| `enrol-staff` CLI | `pnpm --filter agents enrol-staff [--dir <folder>]` on David's machine (needs `AGENT_MNEMONIC`, `AGENT_RPC_URL`, a Playwright Chromium). 1st run: the staff agent signs in through Privy (the user row is created) and stops with the exact `grant-admin` command. 2nd run: enrols, writes the key (before Confirm, so a later failure cannot lose it) and the recovery codes (as soon as shown) to `~/.cherrio/agent-staff-totp-secret.txt` and `~/.cherrio/agent-staff-recovery-codes.txt` (mode 0600; the key file has no newline so `gh secret set … < file` stores it exactly), then drops the 12-hour cookie and checks that the saved key alone passes the code screen. Nothing secret is printed; no screenshot is taken after sign-in (the enrolment screen shows the key). With an existing factor it checks `AGENT_STAFF_TOTP_SECRET` if set, or prints the reset command | Built |
| Redaction | `AGENT_STAFF_TOTP_SECRET` is in the runner's secret list (run log, annotations, errors); the CLI's error line removes it, the mnemonic and the RPC URL (viem errors name the URL) | Built |

Local proof (this sandbox, the real admin pages of a local `next build` with an E2E session cookie, 1440 and 390 px, each twice): a plain user → `not-admin`; an admin without a factor → `enrol` → enrolled (key 32 characters, 10 recovery codes) → after dropping the cookie `verify` → the saved key passed the code screen after 17–29 s (the next step) → `open`. Two driver errors were found this way and fixed before the PR: "Admin Portal" is a label, not a heading (the open state is now the admin menu), and at 390 px a click before hydration was lost.

Live (2026-11-25, David's Mac, dev image `d40a0ed`): 1st run `✓ sign in: POST /api/auth/session → 200` and "not an admin yet (/en/admin → 404)"; `grant-admin` on the dev web container → `Granted PLATFORM_ADMIN role to user 01a21396-…`; 2nd run `✓ authenticator set up; key and recovery codes saved (0600)` → `✓ the saved key opens the admin area`; `AGENT_STAFF_TOTP_SECRET` set in the `agents` environment. A public Amoy RPC was enough for this (the CLI sends no transaction).

The review flow that uses this key is §9 (step 2a); the workflow passes `AGENT_STAFF_TOTP_SECRET` to the run step of the `crew` flow since then.

Sources: `apps/agents/src/staff.ts`, `apps/agents/src/cli.ts` (`enrol-staff`), `apps/agents/test/staff.test.ts`; `apps/web/src/app/[locale]/admin/layout.tsx`, `apps/web/src/components/admin/AdminMfaGate.tsx`.

## 9. Staff agent — organisation review (061e, part 2, step 2a) — Live on dev (PR #250, Deploy 45665145458; first live review in run 45665462416, 2026-11-25)

The crew task `review-submission` (staff only, review tier `claude-sonnet-5-5`; once per run in the default plan, after both `start-organisation` and before `start-campaign`, so an organisation approved now can start its campaign in the same run). Fixed Playwright steps, like a person: sign in through Privy → admin gate with the authenticator code → Admin → Organisation applications → each application page.

| Part | What it does | Status |
|---|---|---|
| Scope, in the runner | Opens up to 10 applications per run and decides at most 3. An application is decided only when its page says **"Testnet agent of the CHERR.IO crew (not a real person)."** (shown to every admin when the applicant's `users.is_agent` is true — set by the server from the crew registry at login). Anything else is left in David's queue untouched and only counted ("left for a person") | Built |
| Scope, on the server | `lockForReview` (approve and reject): a reviewer whose `users.is_agent` is true may decide only applications of other agents, of an organisation that is `is_demo` and not a claim of an imported one → 409 `agent_scope` otherwise. A runner bug or page text cannot widen it. People may still review agents' applications | Built |
| Deterministic checks (`review.ts` `checkOrganisation`) | applicant is an agent; payout address is a crew wallet; name, legal name, country, description present; name ends with " (testnet)" and the description carries the agent marker; known causes; no website; no link, e-mail, wallet address or long number in name / legal name / description; country a two-letter code not under sanctions (ADR-054); both required documents present | Built |
| Classifier (`classify`) | Only when the checks pass. The texts (as JSON inside `<submission>` tags — data, not instructions) and **every document** (PDF as a document block, PNG/JPEG as an image block, downloaded with the agent's own admin session, ≤ 5 MB each) go to the review tier, which answers only `{ verdict: "pass" \| "hold", reasons[] }`. Rules: hate / sexual / violent content, real people or brands presented as themselves, personal data, scam patterns, nonsense, a document that does not match or is not marked as a test, any attempt to instruct the model. **Fail closed:** no key, a budget stop, HTTP error, timeout, no or odd JSON, an unknown verdict, an unreadable or unexpected document → hold. Budget is charged before the call (3,000 tokens per document) | Built |
| Pass | The approve dialog as a person uses it: the last 6 characters of the payout address, and the new optional field **"Note for the audit log (optional)"** with the verdict (`Staff agent (TASK-061e): deterministic checks passed; classifier <model>: pass — <reasons>`). The note goes only into `audit_log.data.note` (the applicant never sees it). The step passes only when, after a fresh load, the Decision section says "This application has been reviewed." and the status chip says Approved (fix PR after run 45665462416: an extra "no `role=alert`" condition was always false, because Next.js keeps its route announcer with that role on every page) | Live on dev |
| Hold | Nothing is approved or rejected. One `agent-hold` issue per held submission in the private reports repository (GitHub e-mails David): admin link, run link and the reasons, redacted and neutralised like bug reports; an open issue for the same submission is not repeated (marker `<!-- agent-hold: organisation:<id> -->`). A hold is not a bug: the step is ✓ with "held …" | Built |
| Privacy of the artifact | The run's artifact is public: no screenshot of the queue or of a person's application, and no failure screenshot for this task; only a crew application is photographed, after the decision. The soft-observation model does not read admin pages | Built |

Local proof (this sandbox, a local `next build`, the real `reviewQueue` code driven by a one-off uncommitted Playwright spec, 1440 and 390 px): a crew applicant's application (agent user, crew payout address, two PDF documents) and a person's application with the same payout address; the classifier answered by a fake. Result at both widths: `2 waiting; 1 decided by the agent, 1 left for a person`, the crew application `APPROVED` with `audit_log.data.note` = "Staff agent (TASK-061e): deterministic checks passed; classifier claude-sonnet-5-5: pass — fictional testnet charity", the person's still `PENDING`, the model got 2 attachments. The first attempt was held by the checks because the test names contained a timestamp (a "long number") — the check working as written.

Read-only review (subagent) before the PR: 2 HIGH (queue and failure screenshots of real applicants in the public artifact), 2 MEDIUM (page-wide match of the agent line and of the "reviewed" text), 1 LOW-MEDIUM (server did not refuse a claim / non-demo organisation for an agent), 2 LOW (Markdown in model reasons in issues and the audit note) — all fixed. Left: a held crew application is classified again on every run until David decides (a few thousand tokens), and only the first 10 queue entries are opened.

Live (run 45665462416, 2026-11-25): the staff agent signed in, passed the code screen and decided the two crew applications waiting — both named "Lantern Hill Reading Fund (testnet)" (Sonnet invented the same name for fundraiser-1 and fundraiser-2). Both were approved (checks + classifier pass); right after, in the same run, both fundraisers started a campaign, which only a verified organisation can do ("Books and Reading Corners for a Small Village Library", goal €100; "Picture books and cushions for a children's reading corner"). The run itself reported both approvals as "approval not shown as saved" — the false negative above, also filed as reports issue #2; reproduced locally with the old condition and fixed.

Not yet (next steps of 061e part 2): publishing (`createCampaign` signed by the staff wallet, linked once indexed) and payout mode. Campaign review is §10.

Sources: `apps/agents/src/review.ts`, `apps/agents/src/staff-review.ts`, `apps/agents/src/reports.ts` (`fileHolds`), `apps/agents/src/llm.ts` (attachments), `apps/agents/test/review.test.ts`; `apps/web/src/lib/organizations/review.ts`, `apps/web/src/app/api/admin/kyb/[submissionId]/approve/route.ts`, `apps/web/src/app/[locale]/admin/kyb/[submissionId]/`; `apps/web/src/__tests__/kyb-review.test.ts`; `.github/workflows/agents.yml`.

## 10. Staff agent — campaign review (061e, part 2, step 2b) — Live on dev (PR #252, Deploy 45683369543; first live review in run 45683594846, 2026-11-25)

Same task `review-submission`, same sign-in and code screen: after the organisation queue the staff agent opens **Admin → Campaigns** (the "Waiting for review" view) and decides the crew's campaigns. Campaigns started in the same run are reviewed in the next run: the task runs once, before `start-campaign` (plan cap unchanged at 9). The two campaigns started in run 45665462416 are the first ones it will decide.

| Part | What it does | Status |
|---|---|---|
| Scope, in the runner | Opens up to 10 campaigns per run, checks at most 6 crew campaigns and approves at most 3 (held ones stay in the queue until David decides them; they no longer use up every slot). The "Crew agent" row is read first; a person's campaign is not read further. A campaign is decided only when its "Campaign data" table has the row **"Crew agent"** with the text "Testnet agent of the CHERR.IO crew (not a real person)." — a row the page renders only when the starter's `users.is_agent` is true (nobody can type a table row into a campaign). Anything else stays in David's queue, only counted | Built |
| Scope, on the server | `lockForReview` (approve and reject): a reviewer whose `users.is_agent` is true may decide only a campaign whose starter is an agent, that is `is_demo`, of an organisation that is `is_demo` → 409 `agent_scope` otherwise. People may still review agents' campaigns | Built |
| Deterministic checks (`review.ts` `checkCampaign`) | starter is an agent; payout address (copied from the verified organisation) is a crew wallet; title and story present; the story ends with the campaign marker; no link, e-mail, wallet address or long number in title or story (the marker's agent name is left out of that check); cause is a known cause label; country Slovenia; goal **as set** in euros and at most €1,000.00 (crew drafts are €100–300) — when the display currency differs the cell reads "≈ $117 (€100)", and only the part in brackets counts; a cover image; no gallery images, videos or documents | Built |
| Classifier | Only when the checks pass: title, cause, country, goal, duration and story as `<submission>` JSON, plus the **cover image** (WebP from the public bucket, ≤ 5 MB, 3,000 budget tokens) to the review tier — same rules and the same fail-closed handling as for organisations | Built |
| Pass | The approve dialog with the new optional field **"Note for the audit log (optional)"** (≤ 500 characters → `audit_log.data.note`, the organisation never sees it), then "Approve with the ECB rate". Saved = after a fresh load the Decision section says "This campaign has been reviewed." and the status chip says Approved | Built |
| Hold | One `agent-hold` issue per held campaign (marker `<!-- agent-hold: campaign:<id> -->`), nothing decided | Built |
| Privacy of the artifact | No screenshot of the queue or of a person's campaign; only a crew campaign after the decision | Built |

Local proof (this sandbox, local `next build`, the real `reviewCampaignQueue` driven by a one-off uncommitted Playwright spec, fake classifier, 1440 and 390 px): a crew campaign (agent starter, demo organisation with a crew payout address, €100, WebP cover, marker) and a person's campaign with the same payout address. Result at both widths: the crew campaign `APPROVED` by the staff agent with `audit_log.data.note` = "Staff agent (TASK-061e): deterministic checks passed; classifier fake-review-model: pass", the model got the WebP cover and the title, the person's campaign still `PENDING_REVIEW`. The first attempt held both crew campaigns — "cover could not be read (cover: download answered 403)" — because the test had uploaded the covers without the `public-read` ACL the app always sets: fail closed, as written.

Live (run 45683594846, 2026-11-25): signed in, passed the code screen, `campaign queue: 2 waiting; 0 approved and 2 held by the agent, 0 left for a person`. Both crew campaigns passed the deterministic checks and were **held by the classifier** — "the texts contradict each other": the goal field said €100 (shown as "≈ $109.35 (€100)") while the model-written story named its own sum. Holds filed as reports issues #3 and #4. Cause in the fundraiser, not the review: `startCampaign` let the model write the story ("a modest goal of a few hundred euros") and only then picked the goal at random. Fix (`fix/agents-campaign-goal-in-story`): the goal is chosen first and given to the writer ("The goal is exactly €200."); `amountsMatchGoal` throws away a title/story that names any other amount, a range, dollars or "a few hundred" (fixed text instead, which names no amount); the classifier gets the goal as set (`goalAsSet`: "€100"), not the display conversion. The two held campaigns stay in David's queue (a hold never decides).

After the fix (2026-11-27; David rejected the two held campaigns by hand): run **45961625027** — both fundraisers submitted new campaigns (€200, €300), both with the fixed text "Warm kennels for the winter" (`fixed text (model answer refused)` — the model's texts named other amounts); run **45962150486** — `campaign queue: 2 waiting; 2 approved and 0 held by the agent, 0 left for a person`, each `approved "Warm kennels for the winter" (checks + claude-sonnet-5-5: pass)`; in the same run both fundraisers submitted their next campaigns with the model's text (`from claude-sonnet-5-5`). **First campaigns started and reviewed only by agents.**

Read-only review (subagent) before the PR: no HIGH; 2 MEDIUM — the goal was read from the first "€" in the cell (a US dollar goal shown as "≈ €92 ($100)" to a viewer with EUR display would have passed), and holds counted toward the 3 decisions so three held campaigns would block newer ones — both fixed; LOW fixed: a person's campaign is no longer read beyond the "Crew agent" row, one failing campaign no longer ends the queue (recorded, no screenshot), the cover link must be `campaigns/<this campaign>/<name>.webp` with no redirects. Re-proved locally after the fixes (both widths): `6 waiting; 1 approved and 2 held by the agent, 3 left for a person` — the new crew campaign approved past two older held ones.

Left (LOW): a held crew campaign is classified again on each run while it waits (each up to one classifier call); the organisation queue still counts holds toward its 3 decisions.

Sources: `apps/agents/src/review.ts` (`checkCampaign`), `apps/agents/src/staff-review.ts` (`reviewCampaignQueue`, `decideCampaign`), `apps/agents/src/llm.ts` (WebP attachments), `apps/agents/test/campaign-review.test.ts`; `apps/web/src/lib/campaigns/review.ts`, `apps/web/src/app/api/admin/campaigns/[id]/approve/route.ts`, `apps/web/src/app/[locale]/admin/campaigns/[id]/`; `apps/web/src/__tests__/campaign-review.test.ts`.

## 11. Staff agent — publishing on Polygon (061e, part 2, step 2c) — Live on dev (PR #255, Deploy 45968086994; fixes #256, #257; first live publish in run 45976097377, 2026-11-27)

Same task `review-submission`, after the two review queues: the staff agent opens **Admin → Campaigns → "Approved — waiting to be published"** and publishes the crew's approved campaigns through the page, like a person (`apps/agents/src/staff-publish.ts`). The staff wallet holds `OPERATOR_ROLE` on the amoy-dev contracts (granted by David 2026-11-25) and pays the gas; `review-submission` is now a spending task, so the treasury tops the staff wallet up to 0.2 POL (no USDC) before the tasks.

| Part | What it does | Status |
|---|---|---|
| Scope, in the runner | Opens up to 10 approved campaigns; reads the server-set "Crew agent" row first (a person's campaign is only counted, never touched). At most **2 publish attempts per run** (each may cost gas) | Live on dev |
| Scope, on the server | `loadForPublish` (prepare and sent) calls the same `assertAgentScope` as the review: an `is_agent` admin may publish only a campaign whose starter is an agent, that is `is_demo`, of an `is_demo` organisation → 409 `agent_scope` (message "A testnet agent may publish only the demo campaigns that the crew started."). Linking ("Check status") stays open to any admin: it only compares the chain with the approval | Live on dev |
| Signer policy | `CampaignFactory.createCampaign` signed by staff only when the beneficiary is a crew wallet and the beneficiary type is organisation (0) — refused otherwise, whatever the page asks | Live on dev |
| Publish | "Publish on Polygon" in the campaign's Publish panel: the page prepares the call, finds the wallet with the operator role (the staff wallet, through the bridge), sends `createCampaign`, stores the hash, waits for the receipt and tries to link for about a minute. Re-clicked only while nothing started (a click before hydration does nothing) | Live on dev |
| Never twice | A campaign whose panel already shows "Sent transaction" (sent in an earlier run) is only checked, never sent again | Live on dev |
| Link | One wait for all campaigns of the run: "Check status" every ~30 s for up to 5 minutes (the dev indexer runs a cycle every 120 s). Linked = the page shows the "On Polygon" section with the campaign contract address. Not linked yet after a send in this run → ✓ "sent, not linked yet" (the next run checks again); sent in an earlier run and still not linked → ✗ | Live on dev |
| Privacy of the artifact | A screenshot only of a crew campaign once it is on Polygon; never of the queue | Live on dev |

Local proof (this sandbox, local `next build`, the real `publishQueue` driven by a one-off uncommitted Playwright spec, 1440 px; APP_ENV=local has no contracts and no Privy, so the page shows "Wallet sign-in is not configured" and no Publish button — sending is proven only live): a crew campaign sent earlier (hash stored), a crew campaign not sent, a person's approved campaign. Result: the earlier one was checked, the test flipped it to Live after 45 s and the agent read `"Crew campaign sent earlier" live at 0xCdCD…CDcD`; the unsent one recorded ✗ "the page says wallet sign-in is not configured here"; the person's campaign untouched; no hash written to either. Deliberate break: `startedByAgent` always true → the person's campaign was attempted and the spec failed on it.

Read-only review (subagent) before the PR: no HIGH; 1 MEDIUM fixed — any status line after the page's flow counted as a send, also "mismatch" or "Something went wrong"; now only "The campaign is not on Polygon yet …" does. Left (LOW): after a timeout the runner moves on while the page may still be between sending and storing the hash; the next run would press Publish again and the page's own checks stop a second send (at worst one reverted transaction). Re-proved locally after the fixes.

Live (run 45968322268, 2026-11-27, after Deploy 45968086994): both publish attempts timed out after six minutes ("the publish flow did not finish"), nothing reported as sent; the timeout detail now says at which step the page stood, which wallet methods it called and whether anything was signed, to find the cause in the next run. Run 45972203242 showed it: the button reads "PUBLISH ON POLYGON" (CSS upper case) and the runner's case-sensitive check took a not-yet-enabled button for a started flow — the page never started (only `eth_accounts`, `eth_chainId`). Fixed: wait for the enabled button, started = its name changed (#257). Run **45976097377** (all green): `publish campaign: sent "Warm kennels for the winter"` twice, then `campaign on Polygon: "Warm kennels for the winter" live at 0x1841864172dc0e6197Ae60d6F65F33cA9E0ACA59` (and the second one) — **the first campaigns started, reviewed and published only by agents.** In the same run the staff agent approved two more crew campaigns.

Payout mode (`setPayoutMode`, ADR-037) stays with the default for now: the policy already allows it for staff, the runner does not use it yet.

Sources: `apps/agents/src/cover.ts`, `apps/agents/test/cover.test.ts` (covers); `apps/agents/src/staff-publish.ts`, `apps/agents/src/policy.ts`, `apps/agents/src/run.ts` (`SPENDING`), `apps/agents/test/core.test.ts`; `apps/web/src/lib/campaigns/publish.ts` (`loadForPublish`), `apps/web/src/lib/campaigns/review.ts` (`assertAgentScope`), `apps/web/src/__tests__/campaign-publish.test.ts`; `apps/web/src/lib/campaigns/publish-flow.ts`.

## 12. Planned

Voting and rating (need campaigns in those states); payout mode by the staff agent; Admin → Agents, the public `/en/agents` page and the schedule (061f).

Sources: `docs/tasks/TASK-061-testnet-agents.md`.

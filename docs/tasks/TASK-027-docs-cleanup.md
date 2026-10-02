# TASK-027 — Documentation cleanup, RPC key masking, TASK-006/026 closure

Branch: `feat/TASK-027-docs-cleanup` (from `dev`) · PR → `dev` · Depends on: TASK-026 · Model: strong (touches the indexer image and deploy workflow)

## Goal

Make every document agree with the code and the ADRs, so the technical docs can be turned into investor PDFs. Close TASK-006 and TASK-026 with real server evidence. Stop the indexer from printing the RPC key in logs. Fix the two small deploy gaps found at go-live.

Precedence when you resolve a contradiction: **code** decides *how it works today*; **ADRs** (`docs/03-DECISIONS.md`, newest wins) decide *what was decided*. Where code and an ADR disagree, do not pick a side yourself — the CTO has already decided each case below. Anything not listed here: list it under *Open questions*, do not fix it.

## Read first

- `CLAUDE.md`, `docs/00-MANIFEST.md`, `docs/03-DECISIONS.md`
- `docs/technical/README.md` (rules for the docs: no secrets, no server IP, `Sources:` lines, status labels)
- `docs/technical/02-smart-contracts.md` §10.1, `03-data-and-indexer.md` §6, `09-status-and-roadmap.md` §5 — the existing contradiction lists
- `docs/tasks/TASK-006.feedback.md`, `docs/tasks/TASK-026.feedback.md`, `docs/CHEATSHEET.md` §5, §6, §10

## Scope

### A. ADRs — add exactly these rows to `docs/03-DECISIONS.md` (date 2026-10-02, status Accepted)

Insert them after ADR-026 (before ADR-019, which stays last as the open item). Copy the text as given.

| ID | Decision | Reason |
|---|---|---|
| ADR-027 | **prod deploys are manual** (`workflow_dispatch` from `main`) until launch; `dev` and `uat` auto-deploy on push. Supersedes "push to each branch auto-deploys" in ADR-020 for prod. | Implemented that way in TASK-022 (`deploy.yml` triggers on `dev`, `uat` only); no automatic production deploy before launch. |
| ADR-028 | **App session lifetime is 7 days** (signed httpOnly cookie, `SESSION_DURATION_SECONDS`). Roles and account existence are re-read from the DB on every admin action, so a deleted or demoted user loses access immediately. Supersedes "short-lived" in ADR-024. | Usable login for donors; the security property ADR-024 wanted comes from the DB re-check, not from a short cookie. |
| ADR-029 | **Indexer schemas are pruned by our own script** (`apps/indexer/lib/prune.ts`): keeps the schema the `chain` views read from and one previous schema for rollback. `ponder db prune` is not used. Supersedes that part of ADR-026. | `ponder db prune` drops every stopped instance's schema, including the one needed for rollback (TASK-026 finding). |
| ADR-030 | **Campaign duration: 7–90 days is the product rule**, enforced off-chain when a campaign is created and approved (TASK-010). The contract keeps 1–90 days as the outer safety bound. | Contracts are non-upgradeable (ADR-009); a wider on-chain bound costs nothing and the product rule can change without a redeploy. |
| ADR-031 | **SINGLE payouts wait 72 hours after the campaign ends** (`releaseDelay`, max 7 days, snapshotted per campaign) so the Guardian can freeze before funds leave. | Added in TASK-003; fraud window for the "first campaign under supervision" rule (Product Spec §2.4). Records an existing contract rule. |
| ADR-032 | **Off-site DB dumps run since TASK-024**: `cherrio_prod` daily, `cherrio_uat` weekly (Sunday), `cherrio_dev` none; encrypted with age (public key on the server, private key only in the password manager). Before mainnet: restore drill with real tables (TASK-023). Updates ADR-023. | ADR-023 said "to be installed before mainnet"; they already run. The remaining mainnet gate is the drill. |

### B. Align documents (text only — no behaviour change)

Fix each item in the listed file(s). Keep each fix minimal; reference the ADR where it helps.

| # | File(s) | Now says | Change to |
|---|---|---|---|
| 1 | `docs/00-MANIFEST.md` §4 (Web3 client, Auth rows) | RainbowKit; Privy **and** SIWE; sessions via Auth.js | Privy for all login methods incl. external wallets (Privy performs SIWE); own signed session cookie (ADR-024, ADR-028); wagmi + viem stay |
| 2 | `docs/02-ARCHITECTURE.md` L7 diagram, L84–85 | RainbowKit, SIWE, Auth.js session | Same as #1 |
| 3 | `docs/02-ARCHITECTURE.md` L36 | Timelock "delayed 48h" | 48 h on mainnet; 5 min on Amoy (ADR-025) |
| 4 | `docs/02-ARCHITECTURE.md` §2.3 (L50–58) | States `MILESTONE_1_RELEASED`, `VOTING_1/2`; SINGLE via `PAYING`; `finalize` "after deadline or when full" | The nine states of `Campaign.sol` and the transitions in `docs/technical/02-smart-contracts.md` §3.2; reaching the target finalizes inside `donate` |
| 5 | `docs/02-ARCHITECTURE.md` L98 | Indexer "writes to schema `chain`" | `chain_<sha7>` tables + views in `chain` + `ponder_sync` (ADR-026, ADR-029) |
| 6 | `docs/02-ARCHITECTURE.md` L175 | migrations run pre-deploy | What `deploy.yml` does today (migrations after the new container takes traffic) + the expand/contract rule that makes it safe; prod manual (ADR-027) |
| 7 | `docs/02-ARCHITECTURE.md` L182 | nightly dumps, monthly drill | As ADR-032; drill cadence as in `docs/technical/08-operations.md` |
| 8 | `docs/02-ARCHITECTURE.md` L189 | Slither in CI | Slither run manually (TASK-004); in CI: **Planned** (TASK-023) |
| 9 | `src/PlatformConfig.sol` L7–9 **comment only** | "must come through the 48h TimelockController" | "through the TimelockController (48 h on mainnet, 5 min on Amoy — ADR-025)". **No code change**; `forge fmt --check` and `forge test` must stay green |
| 10 | `docs/01-PRODUCT-SPEC.md` §2.1, §2.4 | 7–90 days (no bound mentioned); no release delay | Add one line each referencing ADR-030 and ADR-031 |
| 11 | `docs/CHEATSHEET.md` L91 | indexer "will use schema `chain`" | Current ADR-026/029 wording |
| 12 | `docs/CHEATSHEET.md` §5 L147 | `pg_dump` of all 3 DBs daily | As ADR-032 |
| 13 | `docs/CHEATSHEET.md` §6, §10 (L367, L393) and `docs/technical/08-operations.md` L39–40 | Actions → Deploy → "Run workflow" | The button is not shown because `deploy.yml` is not on the default branch `main`. Document what works today: push a change to an indexer path (list from the filter) to force an indexer deploy. Add one line: the button appears once `deploy.yml` is on `main` (David's decision, not this task) |
| 14 | `docs/tasks/TASK-002.feedback.md`, `TASK-003.feedback.md`, `TASK-004.feedback.md`, `packages/contracts/README.md` | The stale statements listed in `docs/technical/02-smart-contracts.md` §10.1 | Do **not** rewrite history in feedback files: append a short `## Correction (TASK-027, 2026-10-02)` section to each, listing what is outdated and where the current truth is. `packages/contracts/README.md` JSON schema section: fix in place |
| 15 | `docs/technical/03-data-and-indexer.md` §6, `docs/technical/09-status-and-roadmap.md` §4, `docs/tasks/README.md` carry-overs | "The exposed key is to be rotated" / "Rotate the Alchemy key" | Decision 2026-10-02 (David): the key is **not rotated**; the account is on pay-as-you-go. Keep the masking item (done in this task, section D) and say so |
| 16 | `docs/technical/02` §10.1, `03` §6, `09` §5 and the `README.md` precedence paragraph | Contradiction lists | Remove each row this task fixed; keep the rest. If a list becomes empty, replace it with "None known (TASK-027, 2026-10-02)" |

### C. Missing brand icon

`apps/web/src/app/[locale]/layout.tsx` declares `apple: "/brand/apple-touch-icon.png"`, but the file does not exist (404). Create a 180×180 PNG from `apps/web/public/brand/favicon.svg` using a tool that is **already installed** on this machine (check with `which`; macOS `sips` cannot read SVG). If nothing suitable is installed, **do not install anything**: stop this item, write `NOT RUN — no SVG renderer installed`, and the CTO will supply the PNG. Proof: `file apps/web/public/brand/apple-touch-icon.png` shows `PNG image data, 180 x 180`.

### D. Mask the RPC key in indexer logs

During the first deploys the full RPC URL (which contains the Alchemy key) appeared in the indexer's logs. Find **where** it is printed (Ponder startup/info lines, viem `HttpRequestError` messages on failed requests, our own code, the deploy job's `kamal app logs` on timeout) and make sure no log line from the indexer container, reconcile or prune contains the key.

Requirements:
- The key must never reach stdout/stderr of the container, `dist/reconcile.mjs` or `dist/prune.mjs`.
- No change to which RPC is used, how often, or Ponder's behaviour.
- Prefer a mechanism inside our code (e.g. a viem transport or wrapper that redacts the URL in errors, or a small log filter in the image's entrypoint that preserves exit codes and signals). Propose the approach **in your plan** with its trade-offs; do not implement before approval.
- Test that can fail: start the indexer (or the relevant code path) with an RPC URL containing a fake key such as `https://example.invalid/v2/TESTKEY1234567890` that makes requests fail, capture the output, and assert the fake key does not appear while a masked form (e.g. `/v2/***`) does. Break the masking once, show the test failing, restore.

### E. Deploy workflow: per-chain RPC secret

`.github/workflows/deploy.yml` job `indexer` exports only `PONDER_RPC_URL_80002`. Add `PONDER_RPC_URL_137: ${{ secrets.PONDER_RPC_URL_137 }}` next to it, so a future `config/indexer.prod.yml` works without editing the workflow. Do **not** create `indexer.uat.yml` / `indexer.prod.yml` and do **not** touch `.kamal/secrets*` (David adds the `PONDER_RPC_URL_137` line there when prod gets an indexer — write that as a step for David in the feedback).

### F. Close TASK-006 and TASK-026 with server evidence

You have no server access. David runs the commands below and pastes the outputs into your session. You write them **verbatim** into the feedback files. Any output David does not provide is written as `NOT RUN — not provided`. Never reconstruct or summarise an output.

1. **GitHub Actions evidence (already known, write as reference):** Deploy run 36923510353 on `dev` (2026-10-01): indexer job steps Deploy, Wait for /ready, Reconcile, Prune all `success`. CI run 36923510253: job "Indexer scenario" `success`.
2. **Server outputs to request from David** (commands from `docs/CHEATSHEET.md` §10.2–10.3), after the TASK-027 PR has been merged and its indexer deploy has finished (this PR changes indexer inputs, so it triggers the **second** indexer deploy):
   - the deploy job's Reconcile and Prune lines from the Actions log — prune must show the new `live=chain_<new sha7>` and `kept=[chain_d991cb3]`;
   - `/status` and `/ready` (`HTTP/1.1 200`);
   - `docker exec $C node dist/reconcile.mjs`;
   - the schemas query, the web-role `select count(*) from chain.campaign` and the denied `update chain.pool`;
   - the indexer-role `select * from app.users limit 1` (must be `permission denied for schema app`);
   - `pg_stat_activity` per role;
   - `docker stats --no-stream $C` and `docker port $C` (must be empty);
   - `curl -s -o /dev/null -w '%{http_code}' https://dev.cherr.io/sql` (must be `404`);
   - one `docker logs --tail 200 $C | grep -c '<first 6 characters of the real key>'` run by David himself — he pastes only the count (must be `0`), never the key.
3. In `docs/tasks/TASK-026.feedback.md`: fill "Manual steps performed on the server" and add `## Server results (TASK-027)` with the outputs; set `Status: DONE` only if every check in step 2 matches its expected result, otherwise keep PARTIAL and list what failed.
4. In `docs/tasks/TASK-006.feedback.md`: add `## Closure (TASK-027)` with the CI reference from step 1 and the reconcile output from step 2; set `Status: DONE`.
5. Because sections D and F only finish after merge, write your feedback in two passes: first pass before the PR (everything except F2–F4, marked `PENDING — after merge`), second pass on a follow-up branch `chore/TASK-027-server-results` with only the two feedback files and `docs/technical/09` (TASK-026 row: drop "feedback still PARTIAL"), which David commits separately.

### G. Technical docs

Per `docs/technical/README.md` maintenance map: update 02 (§10.1), 03 (§6 and the masking), 05 (RPC secret per chain), 06 (key masking, ADR-028 session lifetime), 07 (only if the CI/deploy description changes), 08 (Run workflow wording), 09 (task table: TASK-027; §5 list) and the "Last updated" date of every touched chapter. Name the chapters in the feedback.

## Must not touch

- Any `.sol` file except the comment in item B9. No contract logic, no redeploys.
- `.kamal/secrets*`, `.env*`, `config/deploy*.yml`, `config/indexer*.yml`, `infra/` (none of this task needs them).
- The meaning of existing ADRs: add new rows only (section A); never edit or delete an existing ADR row.
- History in old feedback files: append corrections, never rewrite (B14).
- No new dependencies unless D truly needs one; justify it in the plan.

## Acceptance

- [ ] ADR-027 … ADR-032 present exactly as specified; ADR-019 still last.
- [ ] Every item B1–B16 done or listed as a deviation with a reason.
- [ ] `grep -rn -i -E "rainbowkit|auth\.js|authjs" docs/` returns only historical feedback files and ADR rows that mention the supersession.
- [ ] `grep -rn "MILESTONE_1_RELEASED\|VOTING_1" docs/` returns only the correction notes.
- [ ] apple-touch-icon exists (180×180 PNG) or `NOT RUN` with reason.
- [ ] Masking test: fails with masking broken, passes restored; output shown.
- [ ] `deploy.yml` exports both RPC secrets; YAML parses.
- [ ] `pnpm --filter='!@cherrio/contracts' lint` and `typecheck` clean; `pnpm --filter indexer test` and `test:scenario` green; `pnpm --filter @cherrio/contracts test` green (comment change); `docker build -f Dockerfile.indexer …` succeeds if the image changed.
- [ ] No secret, key, password or server IP added to any document (`grep` for the IP and `alchemy.com/v2/` in `docs/` returns nothing new).
- [ ] Feedback lists the `docs/technical/` chapters updated.
- [ ] Second pass (F): TASK-006 DONE; TASK-026 DONE with verbatim server outputs, or PARTIAL with the failing check named.
- [ ] Size: if the change grows beyond ~800 lines (excluding docs-only rewording), stop and report.

## Suggested commit messages

- `docs: align architecture, manifest, cheat sheet and ADRs with the code (TASK-027)`
- `fix(indexer): never print the RPC key in logs (TASK-027)`
- `ci(deploy): pass PONDER_RPC_URL_137 to the indexer job (TASK-027)`
- second pass: `docs(tasks): TASK-006/026 server results, status DONE (TASK-027)`

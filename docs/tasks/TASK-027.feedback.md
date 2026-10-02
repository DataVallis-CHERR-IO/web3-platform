# TASK-027 feedback — documentation cleanup, RPC key masking, TASK-006/026 closure
Status: DONE

Second pass added on 2026-10-02 (section "Second pass" at the end); everything below it up to that section is the first pass as written before the PR.

First pass (before the PR). Sections A–E and G are done and verified locally. Section F2–F4 is `PENDING — after merge`: it needs server outputs that only David can provide, after this PR's indexer deploy has finished.

## What I implemented
- **A.** ADR-027 … ADR-032 added to `docs/03-DECISIONS.md` after ADR-026, text copied from the task file; ADR-019 is still last; no existing row changed (checked by script).
- **B.** Items 1–16 (table below).
- **C.** `apps/web/public/brand/apple-touch-icon.png`, 180×180, opaque RGB, white background (`#ffffff`, token `white`), symbol centred with 22 px (12 %) padding, square corners.
- **D.** The indexer, reconcile and prune never print the RPC key (`apps/indexer/lib/redact.ts`).
- **E.** `deploy.yml` job `indexer` also exports `PONDER_RPC_URL_137`.
- **G.** Technical chapters updated (list below).

### D — where the key was printed, and the fix
- **Source:** viem puts the full RPC URL into its error messages (`URL: …` in `HttpRequestError`, `RpcRequestError`, `TimeoutError`); its `getUrl` only strips `user:pass@`. Ponder logs those error objects (`"Received JSON-RPC error"`, `uncaughtException`, `unhandledRejection`), reconcile let Node print them, and the deploy job re-prints container logs on a `/ready` timeout. Ponder's own log fields contain only the hostname; our code printed no URL.
- **Fix:** `installRedaction()` wraps `process.stdout.write` and `process.stderr.write` and replaces, for every `PONDER_RPC_URL_*` value: the full URL (shown as `https://host/v2/***`), the last path segment, every query value (raw and decoded), a URL password, and the `encodeURIComponent` form of each. Values shorter than 8 characters are skipped. A pattern for `/v2/<16+ characters>` is the extra safety net.
- **Where it is installed:** first statement of `ponder.config.ts`, `scripts/reconcile.ts` and `scripts/prune.ts`.
- **Uncaught errors:** reconcile and prune install `uncaughtException` / `unhandledRejection` handlers that print the error (with cause) through the filtered stderr and exit 1, because Node prints fatal errors straight to file descriptor 2. `ponder.config.ts` installs no exit handlers (Ponder has its own).
- **`--log-format json` is refused** with a clear error: Ponder then writes to the file descriptor directly, past the filter.
- No change to the RPC used, to request frequency, to Ponder's transport, to exit codes or signals.
- **Known limit:** a secret split across two separate `write` calls would not be matched. Ponder writes one whole log line per call.

### B — items
| # | Result |
|---|---|
| 1 | `docs/00-MANIFEST.md` §4: Web3 client and Auth rows reworded (Privy for all logins, own session cookie, ADR-024/028) |
| 2 | `docs/02-ARCHITECTURE.md`: diagram line, External wallets and Session bullets |
| 3 | Timelock row: 48 h on mainnet, 5 min on Amoy (ADR-025) |
| 4 | §2.3: nine states and their transitions; `finalize()` bullet |
| 5 | §4.2: `chain_<sha7>` + `chain` views + `ponder_sync`, own prune (ADR-026, ADR-029) |
| 6 | §5.3 `deploy.yml` row: prod manual (ADR-027), migrations after the new container takes traffic |
| 7 | §5.4 Backups as ADR-032; drill monthly (first Sunday) as in `docs/technical/08-operations.md` |
| 8 | §6: Slither manual (TASK-004), in CI Planned (TASK-023) |
| 9 | `PlatformConfig.sol` comment only (3 lines) |
| 10 | `docs/01-PRODUCT-SPEC.md` §2.1 (ADR-030) and §2.4 (ADR-031), one line each |
| 11 | `docs/CHEATSHEET.md` §3: indexer schema wording |
| 12 | `docs/CHEATSHEET.md` §5: dump schedule per ADR-032 |
| 13 | `docs/CHEATSHEET.md` §10 (two places) and `docs/technical/08-operations.md`: how to force an indexer deploy today; when the "Run workflow" button appears |
| 14 | `## Correction (TASK-027, 2026-10-02)` appended to `TASK-002.feedback.md`, `TASK-003.feedback.md`, `TASK-004.feedback.md`; `packages/contracts/README.md` JSON schema fixed in place |
| 15 | Key not rotated (decision 2026-10-02): `docs/technical/03` §6, `09` §4, `docs/tasks/README.md` |
| 16 | `docs/technical/02` §10.1: 10 rows removed, 1 kept; `03` §6: item rewritten; `09` §5: 1 row removed, 1 kept until the second pass; `docs/technical/README.md` precedence paragraph |

## Files changed
- `docs/03-DECISIONS.md`, `docs/00-MANIFEST.md`, `docs/02-ARCHITECTURE.md`, `docs/01-PRODUCT-SPEC.md`, `docs/CHEATSHEET.md`
- `docs/tasks/README.md`, `docs/tasks/TASK-002.feedback.md`, `TASK-003.feedback.md`, `TASK-004.feedback.md` (appended only), `docs/tasks/TASK-027.feedback.md`
- `docs/technical/README.md`, `02-smart-contracts.md`, `03-data-and-indexer.md`, `05-infrastructure-and-environments.md`, `06-security.md`, `07-delivery-and-quality.md`, `08-operations.md`, `09-status-and-roadmap.md`
- `packages/contracts/src/PlatformConfig.sol` (comment), `packages/contracts/README.md`
- `apps/indexer/lib/redact.ts` (new), `ponder.config.ts`, `scripts/reconcile.ts`, `scripts/prune.ts`, `package.json` (`test` runs the new test file)
- `apps/indexer/test/redact.test.ts`, `test/fixtures/redact-viem-error.ts`, `test/fixtures/redact-uncaught.ts` (new), `test/scenario.test.ts`
- `.github/workflows/deploy.yml`
- `apps/web/public/brand/apple-touch-icon.png` (new)

### `docs/technical/` chapters updated
02 (§3.2 note, §8 CI sentence, §10.1), 03 (config table, §6), 05 (RPC row), 06 (§4 secrets, §7 session lifetime), 07 (§4.2 dispatch note, §5 indexer tests), 08 (deploy table), 09 (task table, §4, §5), README (precedence). "Last updated" is 2026-10-02 in each. Not touched: 01, 04, 10.

## Deviations from the task (and why)
- **`PlatformConfig.sol` comment** uses an ASCII hyphen (`5 min on Amoy - ADR-025`) instead of the dash in the task text, and is three lines instead of two.
- **Acceptance greps:** besides ADR-024 they still match the task specs `TASK-025-auth.md`, `TASK-003-contracts-milestones-voting.md` and `TASK-027-docs-cleanup.md` (not rewritten, as agreed) and two lines in `docs/technical/04` (L93) and `06` (L122). Those two only describe the supersession, so they were left as they are; no addition to B was needed.
- **B16:** the row about `docs/tasks/TASK-002-contracts-core.md` ("settable once") stays in chapter 02 §10.1: it is a task spec and not in the B table.
- **07 updated** although the task said "only if the CI/deploy description changes": the indexer test description and the `workflow_dispatch` note changed.
- **Cheat sheet §5:** the edited line still contains the Storage Box id that was already there; I changed only the schedule wording. No secret, key or IP was added anywhere.
- **Reconcile and prune** were restructured into a `main()` function so that every failure goes through the filtered error path.

## New dependencies
- none (`sharp` was used from the existing `node_modules` to render the icon; nothing was installed)

## How to verify
1. `pnpm --filter indexer test` → 24 passed (9 of them in `redact.test.ts`).
2. `export DATABASE_URL_DIRECT=postgres://cherrio:cherrio@127.0.0.1:5432/cherrio_dev && pnpm --filter indexer test:scenario` → 20 passed.
3. `cd packages/contracts && forge fmt --check && forge test` → clean, 241 passed.
4. `file apps/web/public/brand/apple-touch-icon.png` → `PNG image data, 180 x 180, 8-bit/color RGB, non-interlaced`.
5. `grep -o "^| ADR-[0-9]*" docs/03-DECISIONS.md | tail -7` → ADR-027 … ADR-032, then ADR-019.

## Test results
- `pnpm --filter indexer test`: 4 files, 24 tests passed.
- `pnpm --filter indexer test:scenario`: 2 files, 20 tests passed (scenario 13, prune 7); reconcile `block=112 checked=398 mismatches: 0`.
- Masking tests: real viem error in a child process (no key, `https://example.invalid/v2/***` present, exit code 7 unchanged); uncaught exception and unhandled rejection (no key, exit 1); real `reconcile` CLI and a real `ponder start` with the fake URL (no key, masked form present).
- **Deliberate break** (`installRedaction` returns before installing): unit `3 failed | 21 passed (24)`, scenario `2 failed | 18 passed (20)`; e.g. `expected 'ContractFunctionExecutionError: HTTP …' to contain 'https://example.invalid/v2/***'`. Restored: 24 and 20 passed.
- The unit test also found a real bug while I wrote it: query values with `+` were not masked in their raw form (fixed).
- `forge fmt --check`: exit 0. `pnpm --filter @cherrio/contracts test`: `241 tests passed, 0 failed, 0 skipped`.
- `pnpm --filter='!@cherrio/contracts' lint` and `typecheck`: 7 projects Done, 0 errors.
- `docker build -f Dockerfile.indexer`: succeeded. In that image, `node dist/reconcile.mjs` with the fake RPC URL and an unreachable database exited 1 through the new handler with 0 occurrences of the fake key.
- `deploy.yml` parses as YAML; job `indexer` env has `PONDER_RPC_URL_80002, PONDER_RPC_URL_137`.

## NOT RUN
- GitHub Actions (CI and Deploy) for this branch — NOT RUN until pushed.
- The masking on the dev server (real key) — NOT RUN; it goes live with this PR's indexer deploy and is checked in F2.
- `pnpm --filter web test`, `next build`, e2e — NOT RUN; the only web change is a new static PNG.
- The icon in a real iOS "Add to Home Screen" — NOT RUN.

## F. TASK-006 / TASK-026 closure
1. **GitHub Actions evidence (reference, from the task file):** Deploy run 36923510353 on `dev` (2026-10-01): indexer job steps Deploy, Wait for /ready, Reconcile, Prune all `success`. CI run 36923510253: job "Indexer scenario" `success`.
2. Server outputs — done in the second pass (first pass: PENDING — after merge)
3. `docs/tasks/TASK-026.feedback.md` update — done in the second pass
4. `docs/tasks/TASK-006.feedback.md` update — done in the second pass

### Steps for David
1. Merge this PR to `dev`. It changes indexer inputs, so the job "Indexer" runs (the second indexer deploy).
2. Paste into the session, verbatim (commands in `docs/CHEATSHEET.md` §10.2–10.3):
   - the Reconcile and Prune lines of the deploy job from the Actions log;
   - `/status` and `/ready`;
   - `docker exec $C node dist/reconcile.mjs`;
   - the schemas query, the web-role `select count(*) from chain.campaign`, the denied `update chain.pool`;
   - the indexer-role `select * from app.users limit 1`;
   - `pg_stat_activity` per role;
   - `docker stats --no-stream $C` and `docker port $C`;
   - `curl -s -o /dev/null -w '%{http_code}' https://dev.cherr.io/sql`;
   - the count only from `docker logs --tail 200 $C | grep -c '<first 6 characters of the real key>'` (never the key).
3. Create branch `chore/TASK-027-server-results` for the second pass (two feedback files and `docs/technical/09`).
4. Later, when prod gets an indexer: create the GitHub secret `PONDER_RPC_URL_137` and add the line `PONDER_RPC_URL_137=$PONDER_RPC_URL_137` to `.kamal/secrets-common`.

## Open questions / risks
Noticed while aligning, not in the task's list, therefore not changed:
- `docs/02-ARCHITECTURE.md` §2.3, `release()` bullet: says it transfers "the currently releasable tranche"; in the code `release()` is valid only in `SUCCEEDED` (SINGLE or tranche 1), tranches 2 and 3 are paid inside `closeVote()` / `resolve(true)`.
- `docs/02-ARCHITECTURE.md` §2.3, events list: `Swept` and the EmergencyPool events are missing.
- `docs/02-ARCHITECTURE.md` §3: "admin actions require a fresh Privy MFA" — I found nothing in the code or feedback files that implements it.
- `docs/02-ARCHITECTURE.md` §2.1: the `PlatformConfig` row does not mention `releaseDelay` or `minDonation`.
- `docs/technical/09` §4 lists "Slither + invariant tests in CI" as a before-mainnet item, while invariant tests already run in CI through `forge test`.
- `docs/tasks/TASK-026.feedback.md` (server step 9) still says "Actions → Deploy → Run workflow"; it will get its correction in the second pass, which edits that file anyway.
- `docs/CHEATSHEET.md` contains the server IP and the Storage Box id by design (operator sheet); the `docs/technical/` rule against them does not apply there, but it means the cheat sheet must not be turned into an investor PDF.
- Masking is by process output only; anything a future dependency writes directly to a file descriptor would bypass it.

## Suggested commit message
- `docs: align architecture, manifest, cheat sheet and ADRs with the code (TASK-027)`
- `fix(indexer): never print the RPC key in logs (TASK-027)`
- `ci(deploy): pass PONDER_RPC_URL_137 to the indexer job (TASK-027)`

## Second pass (2026-10-02, branch `chore/TASK-027-server-results`)

### What I did
- **F2–F3, `docs/tasks/TASK-026.feedback.md`:** `Status: DONE`; "Manual steps performed on the server" filled; new section "Server results (TASK-027)" with David's outputs verbatim, a table of each check against its expected result, and a correction section (opening paragraph, server step 9).
- **F4, `docs/tasks/TASK-006.feedback.md`:** `Status: DONE`; new section "Closure (TASK-027)" with the CI reference and both reconcile outputs.
- **Answers to the open questions:**
  1. `docs/02-ARCHITECTURE.md` §2.3: one line added, "Full function and event list: docs/technical/02-smart-contracts.md §3, §5."
  2. Admin MFA: `docs/technical/04` now says "**Planned** (TASK-021)"; `09` names it as Planned in the TASK-021 row.
  3. `docs/technical/09` §4: invariant tests already run in CI; only Slither in CI remains for TASK-023.
  4. `docs/CHEATSHEET.md`: "Internal — contains server address and account ids; not for external distribution." added at the top.
  5. TASK-026 server step 9: corrected in the new correction section of that file.
- **`docs/technical/09`:** TASK-006, TASK-026 and TASK-027 rows are Done; §4 updated; §5 is now "None known (TASK-027, 2026-10-02)".
- **`docs/technical/03`** §6: second deploy verified (prune kept the previous schema); 165 MiB of 384 MiB at idle after the deploy.

### Every check matched its expected result
Prune `live=chain_31a0a61 kept=[chain_d991cb3]`; `/ready` 200; reconcile 0 mismatches (deploy job and server); four schemas owned by the indexer role; web role reads `chain.campaign` and is denied `update chain.pool`; indexer role denied on schema `app`; connections 2 (web) and 5 (indexer); `docker port` empty; `/sql` 404; key count 0. That is why TASK-026 is DONE and not PARTIAL.

### Files changed (second pass)
- `docs/tasks/TASK-026.feedback.md`, `docs/tasks/TASK-006.feedback.md`, `docs/tasks/TASK-027.feedback.md`
- `docs/technical/03-data-and-indexer.md`, `04-web-app-and-auth.md`, `09-status-and-roadmap.md` ("Last updated" 2026-10-02 in each)
- `docs/02-ARCHITECTURE.md`, `docs/CHEATSHEET.md`
- `docs/tasks/README.md`

### Deviations (second pass)
- The task file limits the second pass to the two feedback files and chapter 09. David's instructions for this pass added chapters 03 and 04, ARCHITECTURE and the cheat sheet.
- `docs/tasks/README.md` was not requested: I updated the TASK-027 row and the indexer carry-over line, because they would otherwise contradict the two feedback files that are now DONE.
- The cheat sheet's "Last updated" date was moved to 2026-10-02.
- "Manual steps performed on the server": only the read-only checks are recorded as performed. For setup steps 1–6 no output was provided, so they are written as `NOT RUN — not provided`, with a note that they are inferred from the working deploy.

### NOT RUN — not provided
- Memory during a full backfill (the figure provided is at idle after the deploy).
- `chain.pool` contents on dev.
- The check that `cherrio_indexer_dev` cannot connect to `cherrio_uat` / `cherrio_prod`.
- Outputs of `ensure-databases.sh` on the server.
- The masking with a real RPC error on the server: no RPC error occurred since the deploy (0 masked lines), so it is proven only by the tests of the first pass.
- No command was run in this pass; it is documentation only. No test, lint or build was re-run.

### Suggested commit message
docs(tasks): TASK-006/026 server results, status DONE (TASK-027)

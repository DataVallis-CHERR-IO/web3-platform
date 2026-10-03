# CHERR.IO — instructions for Claude Code

You are the **implementer** on CHERR.IO, a Web3 charitable-donations platform (Turborepo monorepo).
David (Data Vallis d.o.o.) is the owner: he decides, creates branches, commits, pushes, merges and deploys.
A separate **CTO** (Claude, in the CHERR.IO project chat) writes the specs and reviews your code in the files — not your summary.

@docs/00-MANIFEST.md
@AGENTS.md

## Cloud session — autonomous mode (David, 2026-10-02)
This section applies **only when you run in a Claude cloud session** (a sandbox container, repo at `/home/claude/web3-platform`), not on David's laptop. There, David has made you **CTO + implementer, working autonomously**. Where this section and the rules below disagree, this section wins in a cloud session; everywhere else the rules below stay as written.

- **Start** by reading the claude.ai project doc `docs/HANDOFF.md`: state, working mode, open items, how to set up the sandbox.
- **Git:**
  - commit and push are allowed on `feat/*`, `fix/*` and `docs/*` branches created from `origin/dev`;
  - open PRs to `dev`, wait for CI, and merge only when every check is green, through the GitHub API (`gh api -X PUT repos/DataVallis-CHERR-IO/web3-platform/pulls/<n>/merge -f merge_method=squash`);
  - then check the Deploy run on dev;
  - never push to `dev`, `uat` or `main` directly;
  - `.claude/settings.json` still denies merge/rebase/reset/stash locally.
- **No waiting for approval** on work David has asked for. Plan briefly, then implement, test, PR, merge on green. Stop and ask David only for keys/secrets, accounts, server actions, product decisions, anything on uat/prod, or anything irreversible.
- **The sandbox may be set up** for tests: a local Postgres 16 + pgvector, a `moto` S3 stand-in, Playwright from `/opt/pw-browsers`. These change only the throwaway container, never David's machine or the server.
- **Unchanged:**
  - no `ssh`, no `kamal`, no deploys to uat/prod, no `forge script --broadcast`;
  - never read or print `.env*`, `.kamal/secrets*`, keys or tokens (also not through `git show`);
  - real outputs only, tests that can fail, a feedback file per task, `docs/technical/` updated with honest status labels.
- Reply to David in Slovenian; code, PRs and docs in English.
- **Commit marking (AI-USE.md, NLnet GenAI policy, David 2026-10-03):** every commit with generated code ends with the model trailer (`Co-Authored-By: Claude <model> <noreply@anthropic.com>`) and its body contains a `Prompt:` line — the task spec that served as the prompt (`Prompt: docs/tasks/TASK-011-campaign-pages-donations.md`) or, for ad-hoc work, a one-line summary of David's instruction.

## Read before any task
- `docs/03-DECISIONS.md` — ADRs win over every other document (especially ADR-024 auth, ADR-025 testnet).
- `docs/02-ARCHITECTURE.md` — the sections the task points to.
- `docs/tasks/TASK-XXX-*.md` — your task — and the feedback files of the tasks it depends on.
- `docs/CHEATSHEET.md` — environments, server, databases, deploys.
- `docs/technical/README.md` and the chapter(s) your task touches — the living technical reference (status labels, rules, maintenance map).

## How we work (every task)
1. **Plan first.** Read, then reply with a plan: files to touch, approach, tests, risks, open questions. **Stop and wait for approval.**
2. Implement only the approved scope. Deviations must be listed in the feedback file.
3. Prove it with real outputs (see rules below), write `docs/tasks/TASK-XXX.feedback.md` (template in the manifest §9), then stop and wait for review.
4. **Before you stop, update `docs/technical/`** in the same change: every task that changes behaviour updates the affected chapter(s) per the maintenance map in `docs/technical/README.md` (always 09 when a task is finished), with honest status labels (Live on dev / Built / Planned), `Sources:` lines, no secrets and no server IP, and a new "Last updated" date on every touched chapter.

## Hard rules
- **No git writes.** Never `git commit`, `push`, `merge`, `rebase`, `reset --hard`, `checkout` of other branches, or `stash`. Read-only git (`status`, `diff`, `log`) is fine.
- **No server, no deploys, no keys.** Never `ssh`, `kamal`, `forge script --broadcast`, and never read or print `.env*`, `.kamal/secrets*`, private keys or tokens.
- **Do not change this machine.** No `brew`, global `npm i -g`, `sudo`, starting/stopping services, or creating DB roles. If the environment is broken: stop and report.
- **Never write an output you did not see in this session.** If a command cannot run, write `NOT RUN — <reason>`. Never reuse output from an earlier run.
- **Tests must be able to fail.** No early `return`, swallowed `catch`, or silent skips. A missing dependency (DB, env var) must fail the suite. When you add a guard test, break the code once, show the failure, restore it.
- **One heavy job at a time** (next build, e2e) — they saturate the laptop.
- **Do not run `docker build` locally; CI builds both images on every PR.** Run it locally only if CI's image build fails and you need to debug it.
- Money: USDC `bigint` (6 decimals), never `number`. All UI text through next-intl. No secrets in code or logs.

## Environment
- Node 22 (`nvm use`), pnpm 10.5.2 (corepack).
- Local DB = Docker only: `docker compose -f docker-compose.dev.yml up -d` → Postgres 16 + pgvector on `127.0.0.1:5432`, `cherrio/cherrio/cherrio_dev`; Redis on 6379.
- `export DATABASE_URL=postgres://cherrio:cherrio@127.0.0.1:5432/cherrio_dev` (use `127.0.0.1`, not `localhost`).
- If port 5432 is taken by something else (`lsof -nP -iTCP:5432 -sTCP:LISTEN` shows `postgres`, not `com.docker`), stop and tell David.
- zsh: use single quotes around pnpm filters with `!` (e.g. `--filter '!@cherrio/contracts'`).

## Useful commands
```bash
pnpm --filter='!@cherrio/contracts' lint
pnpm --filter='!@cherrio/contracts' typecheck
pnpm --filter web test                      # needs DATABASE_URL
pnpm --filter @cherrio/db test:integration  # needs DATABASE_URL
pnpm --filter @cherrio/contracts test       # forge, if Foundry is installed
pnpm --filter 'web...' --filter '!@cherrio/contracts' build
cd apps/web && CI=1 pnpm test:e2e          # needs DATABASE_URL, Postgres + s3mock; APP_ENV is set in playwright.config.ts
```

## When you finish
Reply with: files changed, real command outputs (tests, build), anything NOT RUN, deviations, the `docs/technical/` chapters you updated (or "none — no behaviour change"), a suggested commit message. The feedback file lists the same chapters. Then stop.

# CHERR.IO — instructions for Claude Code

You are the **implementer** on CHERR.IO, a Web3 charitable-donations platform (Turborepo monorepo).
David (Data Vallis d.o.o.) is the owner: he decides, creates branches, commits, pushes, merges and deploys.
A separate **CTO** (Claude, in the CHERR.IO project chat) writes the specs and reviews your code in the files — not your summary.

@docs/00-MANIFEST.md
@AGENTS.md

## Read before any task
- `docs/03-DECISIONS.md` — ADRs win over every other document (especially ADR-024 auth, ADR-025 testnet).
- `docs/02-ARCHITECTURE.md` — the sections the task points to.
- `docs/tasks/TASK-XXX-*.md` — your task — and the feedback files of the tasks it depends on.
- `docs/CHEATSHEET.md` — environments, server, databases, deploys.

## How we work (every task)
1. **Plan first.** Read, then reply with a plan: files to touch, approach, tests, risks, open questions. **Stop and wait for approval.**
2. Implement only the approved scope. Deviations must be listed in the feedback file.
3. Prove it with real outputs (see rules below), write `docs/tasks/TASK-XXX.feedback.md` (template in the manifest §9), then stop and wait for review.

## Hard rules
- **No git writes.** Never `git commit`, `push`, `merge`, `rebase`, `reset --hard`, `checkout` of other branches, or `stash`. Read-only git (`status`, `diff`, `log`) is fine.
- **No server, no deploys, no keys.** Never `ssh`, `kamal`, `forge script --broadcast`, and never read or print `.env*`, `.kamal/secrets*`, private keys or tokens.
- **Do not change this machine.** No `brew`, global `npm i -g`, `sudo`, starting/stopping services, or creating DB roles. If the environment is broken: stop and report.
- **Never write an output you did not see in this session.** If a command cannot run, write `NOT RUN — <reason>`. Never reuse output from an earlier run.
- **Tests must be able to fail.** No early `return`, swallowed `catch`, or silent skips. A missing dependency (DB, env var) must fail the suite. When you add a guard test, break the code once, show the failure, restore it.
- **One heavy job at a time** (docker build, next build, e2e) — they saturate the laptop.
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
cd apps/web && CI=1 APP_ENV=dev pnpm test:e2e
docker build -t cherrio-web:local .        # only when the task touches the image
```

## When you finish
Reply with: files changed, real command outputs (tests, build), anything NOT RUN, deviations, a suggested commit message. Then stop.

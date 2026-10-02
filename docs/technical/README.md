# CHERR.IO — Technical documentation

Living technical reference for CHERR.IO. Written so that the founder (or anyone answering for the project — investors, auditors, partners, new engineers) can answer any technical question from one place, with a source for every claim.

Last updated: 2026-10-02

## Chapters

| # | Chapter | Answers questions like |
|---|---------|------------------------|
| 01 | [System overview](01-system-overview.md) | What is CHERR.IO, who are the actors, how does a campaign live and die, what is on-chain vs off-chain? |
| 02 | [Smart contracts](02-smart-contracts.md) | Which contracts exist, state machine, Emergency Pool, roles, timelock, invariants, tests, known limitations |
| 03 | [Data and indexer](03-data-and-indexer.md) | Database layout, `app` tables, GDPR erase, Ponder indexer, reorgs, reconcile, connection budget |
| 04 | [Web app and auth](04-web-app-and-auth.md) | Next.js app structure, Privy login, session cookie, roles, admin, API routes, health endpoint |
| 05 | [Infrastructure and environments](05-infrastructure-and-environments.md) | Hosting, dev/uat/prod, Docker/Kamal services, memory budget, backups, networking |
| 06 | [Security](06-security.md) | Threat model, key custody, server hardening, DB isolation, GDPR, AI-agent controls, open items before mainnet |
| 07 | [Delivery and quality](07-delivery-and-quality.md) | Monorepo, branches, CI jobs, deploy pipelines, test strategy and counts, definition of done |
| 08 | [Operations](08-operations.md) | Operator guide, health checks, incident checklist (links into `docs/CHEATSHEET.md`) |
| 09 | [Status and roadmap](09-status-and-roadmap.md) | What is live, what is built but not deployed, what is planned; task table |
| 10 | [Investor technical FAQ](10-investor-technical-faq.md) | 32 short answers to the questions investors actually ask |

## Status labels

Every feature is marked with one of:

- **Live on dev** — deployed and working on the dev environment (Polygon Amoy testnet).
- **Built** — code merged and tested, not deployed yet.
- **Planned** — decided or specified, not built.

Nothing is live on mainnet yet. Never present Built or Planned as Live.

## Precedence

When documents disagree: `docs/03-DECISIONS.md` (ADRs) > `docs/00-MANIFEST.md` > other `docs/*` > these chapters. Code is the final truth for *how it works today*; ADRs are the truth for *what was decided*. TASK-027 (2026-10-02) aligned the older documents with the code and added ADR-027…032; what is still open is listed at the end of chapters 02 (§10.1), 03 (§6) and 09 (§5).

## Rules for these documents

1. **No secrets, ever.** No passwords, keys, tokens, server IP, Storage Box IDs, Privy App ID, personal emails or full admin wallet addresses. The server is written as `<server>`; wallets only in shortened form (`0x4326…B5a7`).
2. **Sources.** Every section ends with a `Sources:` line pointing to files (and lines where useful).
3. **No invented facts.** If something is not in code, ADRs or feedback files, it is not written here — or it is marked Planned / open.
4. **Honest limitations.** Known risks stay documented (chapter 02 §10, chapter 06 open items). Do not remove them to make the project look better; remove them only when the code fixes them.

## Maintenance (definition of done)

Every task that changes behaviour must update the affected chapter(s) in the same PR:

- contracts → 02 (and 10 if an FAQ answer changes)
- DB schema / indexer → 03
- web app / auth / API → 04
- infra / deploy / backups → 05, 08
- security-relevant change → 06
- CI / tests / process → 07
- any task finished → 09 (status table), and the "Last updated" date of every touched chapter

The implementer states in its feedback file which chapters it updated (or "none — no behaviour change").

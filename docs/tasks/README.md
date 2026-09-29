# Phase 1 task plan

Tasks run strictly in order unless marked parallel (‖). Each needs CTO review of its feedback before the next starts.

| ID | Title | Depends on | Status |
|---|---|---|---|
| TASK-001 | Monorepo scaffold, tooling, CI, local dev stack | – | Ready |
| TASK-002 | Contracts: PlatformConfig, CampaignFactory, Campaign (donate, finalize, refunds, SINGLE payout) | 001 | Ready |
| TASK-003 | Contracts: milestones, voting, Guardian freeze/resolve | 002 | Ready |
| TASK-004 | Contracts: EmergencyPool + sub-pools + allocation votes; Timelock deploy scripts (Amoy) | 003 | Ready |
| TASK-005 ‖ | DB package: Drizzle schema, migrations, seed | 001 | Ready |
| TASK-024 ‖ | Server provisioning, hardening, shared infra (Postgres ×3 DBs, PgBouncer, monitoring, backups), Kamal skeleton | 001 | Ready |
| TASK-006 | Ponder indexer for all contracts | 004, 005 | Ready |
| TASK-007 | Web shell + design system in code: tokens → Tailwind, fonts, 11 components, restyled shadcn/ui, app shell, landing page, `/dev/ui` gallery | 001 | Ready |
| TASK-025 | Auth: Privy (email/social + embedded smart wallet) + SIWE for external wallets, Auth.js session, roles | 005, 007 | Backlog |
| TASK-008 | Organization onboarding + manual KYB admin flow + private uploads | 025 | Backlog |
| TASK-009 | Individual onboarding with Sumsub KYC | 025 | Backlog |
| TASK-010 | Campaign creation, review, EUR→USDC snapshot, on-chain deployment via Safe/operator | 006, 008 | Backlog |
| TASK-011 | Campaign pages + donation flow (wallet, sponsored smart account) | 010 | Backlog |
| TASK-012 | Transak card onramp + "finish your donation" flow | 011 | Backlog |
| TASK-013 | Payout, evidence submission, voting UI, refunds/pool claims | 011 | Backlog |
| TASK-014 | Emergency Pool UI + allocation votes | 013 | Backlog |
| TASK-015 | Ratings + Proof of Charity ledger + levels job | 013 | Backlog |
| TASK-016 | Registry importers (SI, UK, US) | 005 | Backlog |
| TASK-017 | Trust Score v1 job + Charity Market Cap pages + methodology | 015, 016 | Backlog |
| TASK-018 | Public REST API + OpenAPI, llms.txt, JSON-LD, sitemap | 017 | Backlog |
| TASK-019 | Embeddable donate widget (web component) | 012 | Backlog |
| TASK-020 | Read-only MCP server | 018 | Backlog |
| TASK-021 | Admin panel consolidation + audit log | 013 | Backlog |
| TASK-022 | App deploys: `deploy.yml` (push dev/uat/main → env), GHCR images, GitHub Environments + secrets, migrations hook, smoke tests, rollback. **Pulled forward: runs right after TASK-007** so every later task is testable on dev/uat | 007, 024 | Backlog |
| TASK-023 | Audit preparation, Slither, docs; mainnet deployment runbook | all | Backlog |

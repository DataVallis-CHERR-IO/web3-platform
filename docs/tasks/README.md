# Phase 1 task plan

Tasks run strictly in order unless marked parallel (‖). Each needs CTO review of its feedback before the next starts.

Current order (updated 2026-10-02): 001 → 024 → 002 → 003 → 004 → 005 → 007 → 022 → DEPLOY-AMOY (done, amoy-dev) → 025 (done) → 006 (done) → 026 (done) → 027 (done) → **008** → 010 → 011 → …

| ID | Title | Depends on | Status |
|---|---|---|---|
| TASK-001 | Monorepo scaffold, tooling, CI, local dev stack | – | Done |
| TASK-002 | Contracts: PlatformConfig, CampaignFactory, Campaign (donate, finalize, refunds, SINGLE payout) | 001 | Done |
| TASK-003 | Contracts: milestones, voting, Guardian freeze/resolve | 002 | Done |
| TASK-004 | Contracts: EmergencyPool + sub-pools + allocation votes; Timelock deploy scripts (Amoy) | 003 | Done (deployed to amoy-dev 2026-10-01) |
| TASK-005 ‖ | DB package: Drizzle schema, migrations, seed | 001 | Done |
| TASK-024 ‖ | Server provisioning, hardening, shared infra (Postgres ×3 DBs, PgBouncer, monitoring, backups), Kamal skeleton | 001 | Done |
| TASK-006 | Ponder indexer for all contracts | 004, 005, DEPLOY-AMOY | Done (live on dev 2026-10-01) |
| TASK-026 | Indexer deploy (dev): image, Kamal service, indexer DB role + connection budget, deploy job (ready → reconcile → prune) | 006, 022, 024 | Done (live on dev 2026-10-01) |
| TASK-027 | Docs cleanup (contradictions in technical chapters 02, 03, 09) + deploy fixes (mask RPC key in logs, per-chain RPC secret) | 026 | Done (2026-10-02, PR #18; second pass: server results) |
| TASK-028 | CI: build the web and indexer images on every PR (no push); no local docker builds | 008 | Done (2026-10-02; first CI runs green, deliberate break red, merged to `dev`) |
| TASK-007 | Web shell + design system in code: tokens → Tailwind, fonts, 11 components, restyled shadcn/ui, app shell, landing page, `/dev/ui` gallery | 001 | Done |
| TASK-025 | Auth: Privy login (email, Google, MetaMask), app session, account page, roles, coming-soon pages (ADR-024) | 005, 007, 022 | Done (live on dev 2026-10-01) |
| TASK-008 | Organization onboarding + manual KYB admin flow + private uploads | 025 | **Next** (spec pending) |
| TASK-009 | Individual onboarding with Sumsub KYC | 025 | Backlog |
| TASK-010 | Campaign creation, review, EUR→USDC snapshot, on-chain publishing by the operator | 006, 008 | In progress (010a merged and deployed to dev 2026-10-02; 010b built 2026-10-02) |
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
| TASK-022 | App deploys: `deploy.yml` (push dev/uat → env; prod manual until launch), GHCR images, GitHub Environments + secrets, migrations after deploy, smoke tests, rollback | 007, 024 | Done (dev live at dev.cherr.io) |
| TASK-023 | Audit preparation, Slither, docs; mainnet deployment runbook | all | Backlog |

## Carry-overs
- Restore drill with real tables (dev now has the `app` schema).
- Hetzner Cloud Firewall applied to the server — confirm.
- Migrations currently run after the new container takes traffic; revisit once the app reads the DB (expand/contract rule in ARCHITECTURE §5.3 is mandatory until then).
- Indexer: second deploy verified 2026-10-02 (`kept=[chain_d991cb3]`); TASK-006 and TASK-026 feedback are DONE. Still open: memory during a backfill.
- The Alchemy key that appeared in Ponder logs is **not rotated** (decision 2026-10-02, David; the account is on pay-as-you-go). The indexer, reconcile and prune now mask the key in everything they print (TASK-027).
- Every environment's indexer needs a paid RPC plan (`eth_getLogs` ranges ≥ ~1,000 blocks); the Alchemy free tier stalled the first backfill.

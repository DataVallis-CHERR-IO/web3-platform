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
| TASK-010 | Campaign creation, review, EUR→USDC snapshot, on-chain publishing by the operator | 006, 008 | Done (live on dev 2026-10-02: first campaign published on Amoy and linked) |
| TASK-029 | UX fixes and admin overview from the first dev test (account page, form layout, searchable selects, admin menu, KYB documents, admin lists with search/filters/pagination/stats) | 010 | In progress (§1 fixes live on dev 2026-10-03; §3 admin overview built 2026-10-03; §2 moved to TASK-030) |
| TASK-030 | Campaign media: gallery images, YouTube/Vimeo links, public PDFs (ADR-039) | 010 | Live on dev (2026-10-03) |
| TASK-031 | Display currency: amounts in any fiat or crypto currency, display only (ADR-040) | 010, 025 | Live on dev (2026-10-03) |
| TASK-032 | Design system v1.1: cherry wayfinding, section bands, status colours (ADR-041; specified as "TASK-029 design accents") | 007 | Live on dev (2026-10-03) |
| TASK-033 | Voting, refunds, "My donations", notifications and triggers (ADR-045: 7-day vote, 25 % quorum); parts a–f | 011, 026 | Done — 033a–f live on dev (PRs #68, #76–#93; 033f = manual fallback, ADR-050) |
| TASK-034 | Contract admin console: PlatformConfig values in human units, changed through the timelock from Admin → Contracts (ADR-046); parts a–b | 002, 004, 025 | Live on dev (PR #70, #71, 2026-10-04) |
| TASK-035 | Admin pages invisible to search engines, AI crawlers and outsiders: one guard for `/admin`, noindex everywhere, AI-crawler rules (David 2026-10-04) | 025, 034 | Live on dev (PR #75, 2026-10-04) |
| TASK-036 | "Add money": card top-up of the CHERR.IO wallet through Privy's funding flow (Stripe, Coinbase; Transak fallback), minimum 20 €, test-USDC faucet on testnets (ADR-051) | 011c | In progress — 036a live on dev (PR #95: UI, faucet mode, `FUNDING_ONRAMP` switch); 036b live on dev (PR #148: sandbox on dev with the faucet kept, EUR + USD; `TASK-036b.feedback.md`) — David's test-card run on dev open; `production` at launch |
| TASK-037 | Landing page on real published campaigns instead of sample data (pre-MVP list, HANDOFF) | 011a | Live on dev (PR #97, 2026-10-05) |
| TASK-038 | Demo campaigns for testing on dev: admin creates up to 10 per batch from a made-up pool, fal.ai covers, publish all with the Operator wallet, "Demo" badge (ADR-052); parts a–c | 010, 011a, 037 | Live on dev — 038a PR #98, 038b PR #100, 038c PR #101 (2026-10-05) |
| TASK-039 | Cause and country filters on the public campaign list (`?cause=&country=`, chips, country form, empty state) | 011a, 038 | Live on dev (PR #105, Deploy 37275960895) |
| TASK-040 | Demo data in the production flow: demo organisations with their own members (ADR-053); 040b "Act as" / "Fill with AI" dropped (David 2026-10-05) | 038 | Live on dev (040a, PR #104) |
| TASK-041 | Design polish: campaign filter panel layout (David 2026-10-05: "ne da je kr nametano") and the missing `.ch-container` (admin/account pages had no side padding) + a guard test for undefined `ch-*` classes | 039 | Live on dev (PR #106) |
| TASK-042 | Shop-style campaign filters: sidebar of checkbox groups (multi-select, counts, search, "Show all"), active-filter tags, bottom-sheet modal on phones (David 2026-10-05) | 039, 041 | Live on dev (PR #107) |
| TASK-043 | Demo covers: FLUX.2 [pro] as a second fal.ai model (default, cheaper) next to Nano Banana Pro, chosen by the admin (David 2026-10-05) | 038b, 040a | Live on dev (PR #108, Deploy 37286511965; FLUX.2 confirmed by David) |
| TASK-044 | Sanctioned countries refused (forms, validation, KYB and campaign approval, admin warning) + Terms of Service and Privacy Policy drafts (ADR-054) | 008, 010 | Live on dev (PR #109, Deploy 37291440690) |
| TASK-045 | Campaign card polish: bar and long converted figures no longer stick out of the card, smaller card type, no fill stub at 0 % (David 2026-10-05, screenshot of dev) | 011a, 042 | Live on dev (PR #113, Deploy 37297559738; part 2 whole units PR #115, Deploy 37305629486) |
| TASK-046 | Emergency Pool sub-pools: theme rows by migration on every environment + Admin → Emergency Pool sub-pools to create them on chain (Operator) — a slice of TASK-014 (David 2026-10-05) | 004, 033d | Live on dev (PR #117, Deploy 37318110195; fix #119; sub-pools 1–4 created on Amoy-dev by David) |
| TASK-047 | Speed with thousands of campaigns: index-friendly chain joins, page-then-decorate list, landing via partial index, batched "My donations", benchmark + CI speed guard (David 2026-10-05) | 011a, 033b, 037 | Live on dev (PR #118, Deploy 37323798699) |
| TASK-048 | Indexer batch mode on dev (ADR-055): catch up every 2 min with ranged getLogs instead of following every block — ~7× less RPC cost; prod stays realtime (David 2026-10-05) | 006, 026 | Live on dev — #120; incidents 2026-10-06 fixed by #123–#127; green indexer deploy 37452453763 (through the Infura backup) |
| TASK-049 | Admin second factor with own TOTP (ADR-056): enrolment with QR code, recovery codes, required for every admin page and API; parts a (storage + API) and b (enforcement + UI + reset CLI) | 025, 035 | Live on dev (PR #134, #135; Deploy 37573310590) |
| TASK-050 | Terms and Privacy links in the Privy sign-in window (ADR-054, David 2026-10-05): `legal` setting of `PrivyProvider`, links to the current environment's `/<locale>/terms` and `/<locale>/privacy`; no record of the accepted version (only if the legal review asks) | 025, 044 | Live on dev (PR #140, Deploy 37615267825; confirmed by David 2026-10-07) |
| TASK-051 | Admin list view tabs on phones: `.ch-view-nav` turns the Campaigns / Organisations view tabs into a framed one-per-row list at ≤ 640 px (label left, count right); desktop unchanged | 029, 041 | Live on dev (PR #142, Deploy 37626609579) |
| TASK-052 | Storage clean-up: `files:sweep` also removes private `evidence/` objects without a live row and public `campaigns/` objects that no row refers to (`campaign_media.cid`, `evidence_files.public_key`, `evidence_bundles.public_cids`), both older than 1 h | 008, 033c, 037, 038 | Live on dev (PR #143, Deploy 37628374958) |
| TASK-053 | Search and sort on `/campaigns`: `?q=` (title or organisation, case-insensitive) and `?sort=ending|newest|raised` (live campaigns always first); native GET form, works without JavaScript | 011a, 039, 042, 047 | Live on dev (PR #145, Deploy 37634879899) |
| TASK-054 | Accent-insensitive search: public `/campaigns` and admin Campaigns / Organisations searches ignore accents both ways ("sola" ↔ "Šola") through `public.unaccent()` (migration `0015`) | 029, 053 | Live on dev (PR #153, Deploy 37669149090) |
| TASK-055 | Campaign sharing with personal links: share buttons (a) + link preview image (b, Live on dev — PR #159), `?ref=<code>` per signed-in user stored with the visitor's next donation (ADR-057 §5) | 011, 054 | Live on dev (PR #156, Deploy 37686689492; migration `0016` via PR #157) |
| TASK-056 | Proof of Charity v2 (ADR-057): diminishing-return donation points, levels with conditions, "My impact", level badge — spec `TASK-056-proof-of-charity-v2.md` | 033e, 055 | Live on dev (PR #160, #161, #162; Deploy 37731292281) — idle demotion and the public level badge later |
| TASK-057 | Ratings of organisations after a finished campaign, signed with the wallet (ADR-058; 20 points, input to Trust Score v1) — spec `TASK-057-ratings.md` | 033b, 056 | In progress — 057-schema live on dev (PR #163); Live on dev (PR #163, #164, #170) |
| TASK-058 | Account side menu (tabs on phones) and a compact share box: link + copy, icon row, "+20 points" (David 2026-10-08) | 055, 056 | Live on dev (PR #166, Deploy 37745000685) |
| TASK-059 | Static campaign link preview stored once per content + link-preview bots allowed on dev/uat (David 2026-10-08) | 055b | Live on dev (PR #168, Deploy 37751775503) |
| TASK-011 | Campaign pages + donation flow (wallet, sponsored smart account) — spec `TASK-011-campaign-pages-donations.md`, three PRs 011a/b/c | 010 | In progress — 011a live on dev, 011b live on dev (PR #55), 011c live on dev (PR #63) |
| TASK-012 | Transak card onramp + "finish your donation" flow | 011 | Superseded by TASK-036 (ADR-051) |
| TASK-013 | Payout, evidence submission, voting UI, refunds/pool claims | 011 | Superseded by TASK-033 |
| TASK-014 | Emergency Pool UI + allocation votes | 013 | Backlog |
| TASK-015 | Ratings + Proof of Charity ledger + levels job | 013 | Split 2026-10-07 into TASK-055–057 (ADR-057) |
| TASK-016 | Registry importers — spec `TASK-016-registry-import.md`: 016a UK (Charity Commission), 016b US, 016c SI | 005 | In progress — 016a UK and 016b US live on dev (PR #171, #173; US on for dev from the 017-schema PR); 016c SI waits for David's source |
| TASK-017 | Trust Score v1 + Charity Market Cap pages + methodology (ADR-059) — spec `TASK-017-market-cap.md` | 016, 057 | Done — live on dev: 017-schema (PR #174), 017a Trust Score worker (PR #175), 017b list + methodology (PR #176), 017c organisation profile + claim (PR #177) |
| TASK-018 | Public REST API + OpenAPI, llms.txt, JSON-LD, sitemap — spec `TASK-018-public-api-seo.md` | 017 | Done — 018a sitemap + llms.txt live on dev (PR #184); 018b public API v1 live on dev (PR #185) |
| TASK-019 | Embeddable donate widget (web component) | 012 | Live on dev (PR #187) — `/widget.js` + `/embed/campaigns/<slug>`, code on the campaign page; app framing blocked elsewhere |
| TASK-020 | Read-only MCP server | 018 | Live on dev (PR #188) — `POST /mcp` in the web app (Streamable HTTP, 5 read-only tools) |
| TASK-021 | Admin panel consolidation + audit log | 013 | Backlog |
| TASK-022 | App deploys: `deploy.yml` (push dev/uat → env; prod manual until launch), GHCR images, GitHub Environments + secrets, migrations after deploy, smoke tests, rollback | 007, 024 | Done (dev live at dev.cherr.io) |
| TASK-023 | Audit preparation, Slither, docs; mainnet deployment runbook | all | Backlog |
| TASK-060 | Goal currency per campaign (ADR-060) — spec `TASK-060-goal-currency.md` | 010, 011 | Done — live on dev (PRs #189 schema, #190 code, #191 donate panel, #192 drop of the legacy column); feedback `TASK-060.feedback.md` |

## Carry-overs
- **Reown/MetaMask SDK licence decision** before mainnet/prod or above 500 MAU (owner: David): a commercial Reown licence, a confirmed charity exemption, or WalletConnect connectors disabled in Privy. See `docs/technical/08-operations.md` §10.
- Restore drill with real tables (dev now has the `app` schema).
- Hetzner Cloud Firewall applied to the server — confirm.
- Migrations currently run after the new container takes traffic; revisit once the app reads the DB (expand/contract rule in ARCHITECTURE §5.3 is mandatory until then).
- Indexer: second deploy verified 2026-10-02 (`kept=[chain_d991cb3]`); TASK-006 and TASK-026 feedback are DONE. Still open: memory during a backfill.
- The Alchemy key that appeared in Ponder logs is **not rotated** (decision 2026-10-02, David; the account is on pay-as-you-go). The indexer, reconcile and prune now mask the key in everything they print (TASK-027).
- Every environment's indexer needs a paid RPC plan (`eth_getLogs` ranges ≥ ~1,000 blocks); the Alchemy free tier stalled the first backfill.

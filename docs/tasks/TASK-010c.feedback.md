# TASK-010c feedback — publish on Polygon and link through the indexer
Status: DONE (in code) — green locally. GitHub Actions results are in the PR. Labels stay **Built** until David publishes one campaign on dev and it links.

## Steps for David (after the deploy)
1. Connect the operator wallet to your CHERR.IO account if it is not linked yet. On amoy-dev this is the testnet EOA `0x4326…B5a7` in MetaMask (Account → Wallets). It needs some Amoy POL.
2. As a platform admin who is **not** a member of the organisation, approve the campaign you submitted: `/en/admin/campaigns` → open it → Approve. This also proves the ECB rate on dev.
3. On the same page, under "Publish on Polygon", press **Publish on Polygon** and confirm in MetaMask. The page waits for the transaction and the indexer, then shows the contract address with a PolygonScan link and the status **Live**.
4. Send me the transaction hash (or the PolygonScan link). I will read the gas used and add it to technical 02/08.
5. If something stops, the page shows a message. "Check status" can be pressed any time and is safe.

## What I implemented
- **`@cherrio/shared/campaign-address`:**
  - `predictCampaignAddress(factory, implementation, offchainId)` computes CREATE2 of the OpenZeppelin v5 EIP-1167 clone bytecode, i.e. what `CampaignFactory.predictCampaignAddress` returns.
  - Tested against three vectors for the amoy-dev factory and implementation, computed **independently of viem**: Python with pycryptodome keccak and the bytecode read from `Clones.sol` of the pinned OZ submodule.
- **Server** (`lib/campaigns/publish.ts`):
  - `preparePublish` returns the `CreateParams` from the approval snapshot and `deadline = now + duration` (whole seconds, stored), the chain id, factory, PlatformConfig and the predicted address. Preparing again gives a new deadline and keeps the same offchain id.
  - `recordPublishTx` stores the hash (only after a prepare) and writes the audit `campaign.publish_sent`.
  - `linkDeployedCampaign` reads `chain.campaign` by offchain id: columns by name, `state::text`, never the versioned enum type, hex compared lowercase. It links only if address, beneficiary, beneficiary type, target and deadline all match. Then:
    - `DEPLOYED`, `onchain_address`, `deployed_at` = block time, and the hash the indexer saw; audit `campaign.deployed`, once.
    - On a mismatch: audit `campaign.link_mismatch` (once) and no link.
    - Without a `chain` schema: "indexer unavailable" instead of an error.
  - Same admin rules as the review: `PLATFORM_ADMIN` only, not a member of the organisation, only `APPROVED`. Locally (no deployment) → `contracts_unavailable`.
- **API:** `POST /api/admin/campaigns/:id/publish/prepare`, `/sent` and `/check`, in the same frame as the review routes (404 for non-admins, origin check, strict bodies).
- **Browser** (`lib/campaigns/publish-client.ts` + `PublishPanel.tsx`):
  - Uses viem on the admin's Privy-connected external wallet. Every read goes through that wallet's provider, so there is **no RPC key in the web app**.
  - Order of steps:
    1. prepare;
    2. pick the first connected external wallet with `OPERATOR_ROLE` (switching the chain first);
    3. check the chain id, the role, the factory's `predictCampaignAddress` = the server's, `campaigns(offchainId)` still empty (else only link), and that the earlier transaction is not pending;
    4. `createCampaign`;
    5. post the hash;
    6. wait for the receipt;
    7. poll "check" for about a minute.
  - Clear messages for every case; cancelled in the wallet → "You cancelled".
  - Without a Privy app (E2E, CI) the panel shows "Wallet sign-in is not configured" and only "Check status".
- **Admin detail page:**
  - Links on load.
  - The publish panel for `APPROVED`.
  - After `DEPLOYED`, the contract address, transaction, time and a PolygonScan link.
  - The "next step" note from 010b is replaced by the panel.
- **Backlog:** `docs/tasks/TASK-029-ux-fixes-admin-overview.md` holds David's notes from the first dev test, as he asked: account page error, narrow form, visible form errors, searchable country select, admin menu entry, KYB "other" documents, and the admin overview with search, filters, pagination and stats. It is listed in `docs/tasks/README.md` and technical 09.

## Files changed
- `packages/shared/src/campaign-address.ts` (new), `src/index.ts`, `package.json` (sub-path), `test/campaign-address.test.ts` (new)
- `apps/web/package.json`, `pnpm-lock.yaml` — `viem`, `@cherrio/contracts` (ABIs)
- `apps/web/src/lib/campaigns/publish.ts`, `publish-client.ts` (new); `review.ts`, `review-route.ts` (three new refusal codes)
- `apps/web/src/app/api/admin/campaigns/[id]/publish/{prepare,sent,check}/route.ts` (new)
- `apps/web/src/app/[locale]/admin/campaigns/[id]/PublishPanel.tsx` (new), `page.tsx`
- `apps/web/messages/en.json` — `admin.campaigns.publish.*`, `onChain*`, three error texts; `publishLater` removed
- `apps/web/src/__tests__/campaign-publish.test.ts`, `campaign-publish-client.test.ts` (new); `e2e/campaign-review.spec.ts`
- `docs/technical/01, 02, 03 (new §2.5), 04, 06, 07, 08 (new §5.1b), 09`, `docs/CHEATSHEET.md` §7, `docs/tasks/README.md`, `docs/tasks/TASK-029-ux-fixes-admin-overview.md` (new)

## Deviations from the task (and why)
- **viem only, no wagmi** (decided in HANDOFF). The manifest stack lists wagmi + viem, but one transaction does not need wagmi's state layer.
- **The browser refuses to resend while the earlier transaction is still pending, and only links when the factory already has the offchain id.** The spec allows "prepare and send again (new deadline)". Without these two checks, a slow first transaction mined after a re-prepare would put an older deadline on-chain than the DB holds. That campaign would then never link.
- **The starter of the campaign** is refused like a member (as in 010b).
- **`publish_tx_hash` is overwritten with the hash the indexer saw when linking.** That is the transaction that actually created the contract, which matters if the admin's last attempt was a duplicate.
- **Publishing is not audited at the prepare step**, only at send, link and mismatch, as listed in the task.

## New dependencies
- `viem@^2.56.0` (apps/web; already in the workspace through `@cherrio/shared`, Privy and wagmi connectors) — contract calls from the browser. The lockfile now resolves one `viem` 2.56.9 for these packages; the drift to 2.56.0 that `pnpm add sharp` caused in 010a is gone.
- `@cherrio/contracts` (workspace) in apps/web — ABIs.

## How to verify
1. `export DATABASE_URL=postgres://cherrio:cherrio@127.0.0.1:5432/cherrio_dev DATABASE_URL_DIRECT=$DATABASE_URL`
2. `pnpm --filter @cherrio/shared test` → 60 passed
3. `pnpm --filter web test` → 18 files, 125 passed
4. `pnpm --filter @cherrio/db test:integration` → 16 passed
5. Build, then `cd apps/web && CI=1 pnpm test:e2e` → 106 passed

## Test results (all from this session)
Environment: the same cloud sandbox as 010b — local Postgres process, `moto` as s3mock, a font mock for `next build`, and the preinstalled Chromium headless shell. The sandbox restarted once in between; I restarted Postgres and moto and re-ran.

Results:
- `@cherrio/shared`: `Tests 60 passed (60)` (5 new: three vectors, case, wrong length).
- `web`: `Test Files 18 passed (18)`, `Tests 125 passed (125)`. New:
  - `campaign-publish-client`: 4 tests against a fake EIP-1193 provider. The sent transaction is decoded and its parameters checked; wrong chain, no role, other prediction and pending earlier transaction are each refused without sending; an existing campaign only links; a dropped earlier transaction does not block.
  - `campaign-publish`: 4 tests on Postgres with a `chain.campaign` table of the view's columns. Covered: prepare; full path prepare → sent → indexer row → DEPLOYED, audited once; four kinds of mismatch, not linked, audited once each; routes (404, `contracts_unavailable` locally, `indexer_unavailable`, hash format, `not_prepared`, member refused, `not_approved`).
- `@cherrio/db` integration: `Tests 16 passed (16)`.
- Lint, typecheck, design check: no errors.
- **Deliberate break 1** (`target` not compared when linking): `Tests 1 failed | 3 passed (4)`, with `{"target":"14080800001"}: expected { status: 'DEPLOYED', …(1) } to deeply equal { status: 'APPROVED', …(2) }`. Restored → 4 passed.
- **Deliberate break 2** (last byte of the EIP-1167 suffix changed in `predictCampaignAddress`): `Tests 4 failed | 1 passed (5)`. Restored → 60 passed.
- E2E, whole suite, first run: `2 failed, 104 passed (3.1m)`:
  - axe violations on `/en/account/campaigns/[id] (in review)` (1440) and `/en/account/organization (pending)` (390);
  - both are pages this task does not touch.
  - Re-running both specs: `14 passed`. I treat it as a flake (axe during a toast or transition). CI runs with 2 retries. It is a candidate for TASK-029 if it shows up again.
  - The changed `campaign-review` spec (publish panel and "Check status") passed in that run.

## NOT RUN
- Signing a real transaction: not automated (the task says so). Proven by David's first publish on dev.
- Reading the real `chain.campaign` view on dev: columns taken from HANDOFF (confirmed on dev earlier). Proven by the first link.
- docker build: CI only.
- Gas of `createCampaign`: after the first publish.

## Open questions / risks
- **The indexer lag decides how fast "Live" appears.** The page polls for about a minute; after that, "Check status" or a reload.
- **Mainnet:** this flow signs with an EOA. On mainnet the operator is a Safe, so the same action must create a Safe proposal (TASK-023). This is not built.
- **Several connected external wallets:** the first one with `OPERATOR_ROLE` is used. There is no picker; it is not needed with one operator.

## Suggested commit message
feat(web): publish approved campaigns on Polygon from the admin's browser and link them through the indexer (TASK-010c)

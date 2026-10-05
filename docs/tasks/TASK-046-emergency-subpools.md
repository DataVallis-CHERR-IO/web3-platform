# TASK-046 — Emergency Pool sub-pools on every environment

Status: Built (PR pending) · Owner: cloud session (CTO + implementer) · Requested by David, 2026-10-05 ("Začni s 3")
Depends on: TASK-004 (EmergencyPool), TASK-033d (admin wallet gate, chain-action pattern). A slice of TASK-014 (Emergency Pool UI), which otherwise stays Backlog.

## Why
The donate panel offers an Emergency Pool theme only when the theme exists both in `app.emergency_subpools` and on chain (`chain.pool`, `listDonationThemes`). On dev neither side existed: the rows came only from `pnpm --filter db seed`, which no deploy runs, and the sub-pools 1–4 were never created on chain (`createSubPool` was "Polygonscan by hand" in the owner guide). Donors therefore only ever saw "General". This is on the pre-MVP list.

## Scope
1. **Migration `0012_seed_emergency_subpools.sql`** (data only): the five rows of `seed.ts` (general 0, medical 1, disasters 2, animals 3, climate 4), same message keys, `gen_random_uuid()` ids (uuidPk has no DB default), `ON CONFLICT DO NOTHING`. Backward compatible (insert only).
2. **Admin → Emergency Pool sub-pools** (`/en/admin/emergency-pool`, PLATFORM_ADMIN, 404 otherwise; button on `/en/admin`):
   - table: theme name, id, on the blockchain (Yes / Not yet), balance (USDC) — `loadSubpools(db)` = rows ⨝ `chain.pool`; "unavailable" without the indexer views;
   - per missing theme (id > 0): "Create on the blockchain" — the Operator's external wallet (`AdminWalletGate`, roles via `/api/rpc`) sends `EmergencyPool.createSubPool(id)` after a simulation (`sendCreateSubPool`); refusals named (`PoolAlreadyExists` → already done, `NotOperator`, wrong network, rejected);
   - `POST /api/admin/emergency-pool/subpools/sent` → audit `pool.subpool_create.sent`.
   - EmergencyPool address from the deployment file; `LOCAL_EMERGENCY_POOL_ADDRESS` on local (E2E).
3. Owner guide v1.7 (§8 row + "Creating the Emergency Pool sub-pools"), technical 03/04/09, this spec, feedback.

## Out of scope
Public pool pages, direct pool donations, allocation proposals/votes (TASK-014). New themes beyond the five (needs message keys + a migration).

## Tests
- DB integration: migrations alone create the five rows with the seed's keys.
- Vitest: `sendCreateSubPool` (simulate → send, refusals never reach the wallet, wrong network, rejected), `emergencyPoolAddress`, `loadSubpools` with fake chain rows, the sent route (404 / 403 / 400 / 404 unknown id / 200 + audit).
- E2E `admin-emergency-pool.spec.ts` (1440 + 390): table rows, create from the fake Operator wallet → calldata `createSubPool(id)` + audit row, a wallet without the role sees the notice and a disabled button; axe.

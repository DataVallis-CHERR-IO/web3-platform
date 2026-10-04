# TASK-034b feedback — Admin → Contracts page and the owner guide
Status: DONE

## What I implemented
- `/en/admin/contracts` (PLATFORM_ADMIN only, 404 otherwise), linked from the admin home:
  - setup panel: network, PlatformConfig and timelock addresses, timelock delay in words, each connected wallet with its roles;
  - every PlatformConfig value in human units with the raw on-chain value; inputs with the contract's bounds (percent, number + minutes/hours/days, USDC, address); readable field errors ("The highest allowed value is 14 days.");
  - review table (now → new, human + raw) → `scheduleBatch` signed in the wallet holding the proposer role → recorded through `POST /api/admin/contracts/changes`;
  - scheduled changes with their on-chain state (waiting until … / ready / done / unset) → Apply (`executeBatch`, same arguments) or Cancel; history of applied/cancelled changes;
  - no proposer wallet → "Download for Safe" (Safe Transaction Builder JSON of the same `scheduleBatch`).
- `lib/contracts/console-client.ts` — browser reads/writes (snapshot, roles incl. OZ open executor role, operation state, schedule/execute/cancel with chain + role + readiness checks, error mapping).
- `consoleContracts()` on `APP_ENV=local` uses `LOCAL_TIMELOCK_ADDRESS` + `LOCAL_PLATFORM_CONFIG_ADDRESS` (set by `playwright.config.ts` for E2E; usable with a local Anvil deployment).
- **Owner guide** (David 09:30): source `docs/guides/owner/contracts-owner-guide.md`, PDF `docs/guides/owner/dist/CHERR.IO-Contracts-Owner-Guide-v1.0.pdf` (15 pages), built with the whitepaper design (`docs/whitepaper/build.mjs` got a `--src` option and an `owner-guide` npm script; the whitepaper build is unchanged by default). Maintenance rule in `docs/guides/owner/README.md`, `docs/technical/README.md` and the task spec.

## Files changed
- `apps/web/src/app/[locale]/admin/contracts/{page,ContractConsole}.tsx` — new.
- `apps/web/src/lib/contracts/console-client.ts` — new; `changes.ts` — local env addresses.
- `apps/web/src/app/[locale]/admin/page.tsx` — "Contracts" link.
- `apps/web/messages/en.json` — `admin.contracts.*`, `admin.contractsLink`.
- `apps/web/playwright.config.ts`, `playwright.env.ts` — E2E console addresses.
- `apps/web/src/__tests__/contract-console-client.test.ts` (9 tests), `apps/web/e2e/contract-console.spec.ts` (2 tests × 2 viewports) — new.
- `docs/guides/owner/*` — new (source, README, PDF, `.gitignore` keeping `dist/`).
- `docs/whitepaper/build.mjs`, `package.json` — `--src`, `owner-guide` script.
- Docs: task spec (owner guide section), `docs/tasks/README.md`, technical 02, 04, 09, technical README (maintenance rule).

## Deviations from the task (and why)
- The Safe JSON download is not recorded in `contract_changes` (the transaction happens in the Safe app, the console never sees its hash). Changes made through the Safe appear in the console only after the full Safe proposal flow (TASK-023). Written in the guide.

## New dependencies
- none in the workspace (the whitepaper folder's own `npm install` is unchanged).

## How to verify
1. Log in as admin on dev → Admin → Contracts. Values show in words (e.g. "1 day", "50%"), the waiting time says "5 minutes".
2. With the owner wallet connected, the setup panel lists "can schedule changes, can apply changes, …".
3. Owner guide: open `docs/guides/owner/dist/CHERR.IO-Contracts-Owner-Guide-v1.0.pdf`.

## Test results (real outputs, this session)
```
 ✓ src/__tests__/contract-console-client.test.ts (9 tests) 81ms
      Tests  9 passed (9)
```
E2E (`CI=1 pnpm exec playwright test e2e/contract-console.spec.ts --retries=0`, after `pnpm build`):
```
  4 passed (18.1s)
```
(earlier runs in this session failed on a wrong button name in the test and on an axe contrast violation of the eyebrow, `#ff0052` on `#e3e3e3` = 3.04:1; fixed by using the design system's `ch-eyebrow` class.)
Full unit suite:
```
 Test Files  37 passed (37)
      Tests  348 passed (348)
```
Lint, typecheck: clean. `pnpm check:design`: "Design check passed — no violations found."
Deliberate break — proposer check removed from `scheduleChange`:
```
   × writing > refuses a wallet without the proposer role, or on the wrong network, before sending 13ms
      Tests  1 failed | 8 passed (9)
```
Restored → 9 passed.
Owner guide build:
```
HTML  /home/claude/wt-034b/docs/whitepaper/build/contracts-owner-guide.html
PDF   /home/claude/wt-034b/docs/guides/owner/dist/CHERR.IO-Contracts-Owner-Guide-v1.0.pdf  (15 pages)
```
Whitepaper default build still works: `npm run html` → `HTML  …/build/whitepaper.html`. Pages 1, 2, 6, 7 and 8 of the guide were rendered to PNG and checked by eye.

## Open questions / risks
- On dev, reads go through `/api/rpc`; if the public Amoy RPCs are unreachable from the server the page shows "The contracts could not be read" (then `RPC_URL` as a web secret helps, see PR #66).

## docs/technical chapters updated
02, 04, 09, README (maintenance rule).

## Suggested commit message
feat(admin): contract console page and owner guide PDF (TASK-034b)

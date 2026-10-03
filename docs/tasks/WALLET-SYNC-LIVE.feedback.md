# Live wallet sync on the account page (feedback)
Status: DONE — follow-up to TASK-011c from David's test on dev (2026-10-03).

## What David saw
- After a first email login, "Linked wallets" stayed empty until he reloaded: Privy creates the embedded wallet seconds after login, after our session already exists, and nothing re-synced.
- No "Donation account" row even after a reload (smart account missing). Root cause under investigation with David (Privy dashboard vs. code) — this PR makes the sync robust either way.

## What I implemented
- `lib/auth/wallet-sync.ts`: `missingWalletAddresses(linkedAccounts, stored, smartClientAddress)` and `WALLET_SYNC_DELAYS_MS` (0, 2, 5, 10, 20 s).
- `PrivyClientProvider`: `WalletSync` replaces `SmartAccountSync`. It watches every wallet + smart-wallet address Privy reports in the browser (and the smart-account client's address) and calls `POST /api/auth/wallets/sync` while one is missing, with spaced tries; tries start again when Privy links the smart account (`privyUser.smartWallet` changes). The server still reads the Privy user record itself.
- Account page: "Your wallet is being created…" (no address yet) and "Your donation account is being prepared…" (smart-account client present, not yet stored) notices; rows appear without a reload.

## Files changed
- `apps/web/src/lib/auth/wallet-sync.ts` (new), `apps/web/src/components/auth/PrivyClientProvider.tsx`, `apps/web/src/app/[locale]/account/AccountClient.tsx`, `apps/web/messages/en.json`
- `apps/web/src/__tests__/wallet-sync.test.ts` (new, 5 tests)
- `docs/technical/04-web-app-and-auth.md` §4.2

## Deviations
- none

## Test results (this session)
```
$ pnpm exec vitest run src/__tests__/wallet-sync.test.ts
      Tests  5 passed (5)
```
Deliberate break — `smart_wallet` accounts ignored:
```
   × missingWalletAddresses > reports a linked smart wallet missing from the stored addresses 7ms
      Tests  1 failed | 4 passed (5)
```
Restored → `Tests  5 passed (5)`.
```
$ pnpm --filter='!@cherrio/contracts' lint       → apps/web lint: Done
$ pnpm --filter='!@cherrio/contracts' typecheck  → apps/web typecheck: Done
$ pnpm --filter web test
 Test Files  33 passed (33)
      Tests  264 passed (264)
$ pnpm build → exit 0
$ CI=1 pnpm exec playwright test e2e/auth-nav.spec.ts e2e/donate.spec.ts e2e/a11y.spec.ts --retries=0
  92 passed (1.7m)
```
The live Privy behaviour (timing of wallet creation and smart-wallet linking) cannot run here (no Privy app in tests) — proof is David's next first login on dev.

## Root cause of the missing smart account (David's console, 2026-10-03)
The browser console showed `CallExecutionError: HTTP request failed. URL: https://rpc-amoy.polygon.technology/` for an `eth_call` whose data is the EntryPoint v0.6 `getSenderAddress` helper with David's embedded wallet `0x243c…262c` as owner, plus "Cross-Origin Request Blocked … CORS request did not succeed". Privy's smart-wallet client computes the account address through the chain's RPC (our `amoyChain.rpcUrls`); that public endpoint fails from the browser, so the client was never created, the panel waited 8 s ("Preparing your wallet…") and fell back to the embedded wallet ("Your wallet pays a small network fee in POL").

Fix: the chain's RPC in the browser is now our own origin, `POST /api/rpc` — a read-only proxy (`lib/chain/rpc-proxy.ts`): allow-listed read methods, own origin only, 300/min per IP, batch ≤ 20, body ≤ 64 KB, upstreams `RPC_URL` (optional) → publicnode → official Polygon RPC with fallback on network error / timeout / 5xx; upstream URLs never in responses.

```
$ pnpm exec vitest run src/__tests__/rpc-proxy.test.ts
      Tests  11 passed (11)
```
Deliberate break 1 — `eth_sendRawTransaction` added to the allow-list:
```
   × checkRpcBody > refuses eth_sendRawTransaction 9ms
   × POST /api/rpc > refuses another site's origin and a write method — nothing is forwarded 3ms
      Tests  2 failed | 9 passed (11)
```
Deliberate break 2 — origin check disabled:
```
   × POST /api/rpc > refuses another site's origin and a write method — nothing is forwarded 9ms
      Tests  1 failed | 10 passed (11)
```
Restored → `Tests  11 passed (11)`.

Smoke against the built server (`next start`, APP_ENV=local, no local chain running):
```
own origin:      {"error":"rpc_unavailable"} [502]   (no Anvil locally — expected)
foreign origin:  {"error":"forbidden"} [403]
write method:    {"error":"method_not_allowed"} [400]
```
Whole web suite after both changes: `Test Files  34 passed (34)`, `Tests  275 passed (275)`; lint, typecheck, build: ok.

Not provable here: whether the Hetzner server reaches publicnode / the Polygon RPC (public RPCs are unreachable from this sandbox). If both fail on dev, `/api/rpc` answers 502 and David can set `RPC_URL` (the Amoy Alchemy URL) as a secret.

## Suggested commit message
fix(web): account page picks up new wallets without a reload

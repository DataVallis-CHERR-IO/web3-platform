# TASK-061 feedback
Status: PARTIAL — 061a done; 061b done (live on dev, run 45607120118); 061c migration in review; 061c code, 061d–f open

## 061a — runner core (2026-11-24)

### What I implemented
- New workspace package `apps/agents` (no service, no image): crew wallets from one mnemonic, the dev-only guard, the signer policy, the wallet bridge for Playwright (EIP-1193 + EIP-6963), the top-up plan and CLI, the run log with redaction, budget caps, and model routing (dispatcher on Opus 5.5, cheaper tiers for the work — David 2026-11-24).

### Files changed
- `apps/agents/**` — the package and its tests
- `pnpm-lock.yaml` — the new importer
- `docs/technical/11-testnet-agents.md` (new), `README.md`, `06`, `07`, `09` — see below

### Deviations from the task (and why)
- Model routing (`models.ts`) is not in the 061a list of the spec: David asked for it while 061a was being written. The spec and ADR-063 get the paragraph in a docs PR once the spec PR (#222) is merged.
- No Playwright dependency yet: the bridge is plain functions plus a script string, so it is tested without a browser. Playwright arrives with the workflow in 061b.

### New dependencies
- none new to the repo (`viem` is already used by web, indexer, shared and contracts)

### How to verify
1. `pnpm --filter agents test` → 23 passed
2. `AGENT_MNEMONIC="test test test test test test test test test test test junk" pnpm --silent --filter agents addresses` → nine lines, index 0 = `0xf39f…2266` (the public Anvil phrase)
3. Without `AGENT_MNEMONIC` → `AGENT_MNEMONIC is required`, exit 1

### Test results (this session)
```
 ✓ test/core.test.ts (23 tests) 120ms
      Tests  23 passed (23)
```
`pnpm --filter agents typecheck` and `lint`: no errors.

Deliberate breaks (each restored with the reverse `sed`, then 23 passed again):
| Break | Result |
|---|---|
| Guard compares the origin with `startsWith` | `× guard > accepts the testnet on Amoy only` (`https://testnet.cherr.io.evil.example` got through) |
| `freeze` added to the campaign allow-list | `× signer policy > never signs Guardian calls, for anyone` → `donor: expected true to be false` |
| Bridge ignores a refusing verdict | `× wallet bridge > sends an allowed transaction and never sends a refused one` → `promise resolved "'0xabab…'" instead of rejecting` |

NOT RUN — `pnpm --filter agents fund`: needs an Amoy RPC and a funded treasury; the sandbox reaches neither. Its arithmetic (`planTopUps`) and the policy it calls are covered by the tests above.
NOT RUN — anything against testnet.cherr.io (unreachable from the sandbox).

### Open questions / risks
- Whether Privy's sign-in window accepts the injected wallet in headless Chromium is only known after the first live run (061b). Fallback: Privy's own test accounts.
- Typed-data signing is limited by chain only; when 061d uses ratings, tighten it to the app's own EIP-712 domain.
- Reports as GitHub Issues would be public in this repository — a private reports repository is recommended (David to decide before 061d).
- The lockfile change makes the next dev Deploy re-index (indexer inputs include `pnpm-lock.yaml`).

### docs/technical chapters updated
11 (new), README (chapter list), 06 §10, 07 §5, 09 (§2 and the task table).

### Suggested commit message
feat(agents): runner core for the testnet crew (TASK-061a)

## 061b — first live flow (2026-11-25)

### What I implemented
- `apps/agents/src/run.ts` (flow `donor`), `src/chain.ts` (agents' RPC, policy context, signer that passes the page's gas/fee fields), workflow `.github/workflows/agents.yml` (manual, dev only, environment `agents`, artifact upload).
- Bridge: `TxRequest` carries `gas` / `maxFeePerGas` / `maxPriorityFeePerGas` through to the signer (not part of the policy). Run log: exact secret values (the RPC URL) are redacted too.
- First-run top-up levels 2 → 5 USDC (David's treasury had 20 USDC from the faucet).

### Deviations
- No model in this flow: login and donation are fixed steps, so the first run costs no tokens. The dispatcher arrives with 061d.
- Secrets in a GitHub **environment** `agents` without a branch rule (David's plan does not offer deployment-branch rules); the job itself runs only when `github.ref == refs/heads/dev`.

### Test results (this session)
- `pnpm --filter agents test` → 25 passed (2 new: URL redaction, fee pass-through); typecheck and lint clean; `actionlint` on `agents.yml` clean.
- Smoke in a real headless Chromium (temporary script, not committed) with the public Anvil phrase: `{"seen":["CHERR.IO test wallet"],"chain":"0x13882","accts":["0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"],"block":"0x10","refused":"4100 method not allowed: eth_sign"}` — the page sees the EIP-6963 wallet, identity and reads work, a non-allowed method is refused.
- NOT RUN — the live flow (testnet unreachable from the sandbox; secrets live in GitHub). First run: Actions → Agents → Run workflow on `dev`.

### Risks
- Privy's sign-in window may name the wallet button differently or ask for an extra click; the run takes screenshots of each step and fails with the step name.

### Independent review (read-only subagent) and fixes, before the first run
| Finding | Rating | Fix |
|---|---|---|
| Typed data checked only by chain: a page could ask for a USDC EIP-2612 `Permit` (moves USDC with no transaction the policy sees); signer address not checked | HIGH | `checkTypedData`: only the app's `Rating` message (exact domain and types); signer must be the wallet — 2 tests; deliberate break (primary-type rule off) → `signs only the app's own rating message…` failed |
| Wallet answered every frame and origin (iframe, redirect) | HIGH | `exposeBinding` + top frame on the testnet origin only. Real Chromium: `{"top":"0x13882","inFrame":"error 4100","elsewhere":"error 4100"}` |
| Page-chosen gas/fees passed to the signer unchecked | MEDIUM | `checkFees` caps — test; deliberate break (check skipped) → `refuses fees above the caps…` failed |
| Error texts (can contain the RPC URL) returned to the page and into the summary | MEDIUM | page gets codes only; step details, summary and the final error redacted |
| Secrets usable from any branch that edits the workflow (job `if:` only) | MEDIUM | Not fixable on David's plan (no deployment-branch rules); only collaborators can push branches. Accepted, documented |
| Slug from the URL; refused methods only in run.jsonl; actions pinned by tag | LOW | slug from the API; rest left as is |

Tests after the fixes: agents 28 passed; typecheck, lint clean.

### First live run (2026-11-25, Actions run 45595521830)
- `guard` ✓, `top-up` ✓ — 2 transfers from the treasury to donor-1 on Amoy (POL and USDC).
- `pick campaign` ✗ — "no live campaign": the runner compared with `LIVE`, the public API reports `live` (lower case, `PublicState`). Fixed in `fix/agents-live-state`; second run below.

### Runs until the first end-to-end donation (2026-11-25)
| Run | Result | Fix |
|---|---|---|
| 45596868393 | failed after 37 s with no step annotations | steps printed synchronously (#230) |
| 45598597151 | Privy window open, no "CHERR.IO test wallet" button | diagnostics: visible buttons + wallet calls (#232; worker tests `--no-file-parallelism` after three CI flakes) |
| 45601917695 | Privy lists MetaMask, Coinbase, Rainbow, WalletConnect wallets — no other injected wallet | wallet presents as MetaMask in the agents' browser (#233) |
| 45603596943 | `wallet_requestPermissions` refused → Privy "Retry" | grant `eth_accounts` only (#234) |
| 45605361497 | **sign in ✓ (`/api/auth/session` 200), donation on chain ✓, indexed ✓ (API = chain, 1096300)**; the step check expected exactly 1 USDC, but the goal was in EUR (typed 1 → 1.0963 USDC) | compare with the amount the page shows (`You send exactly … USDC`) |
| 45607120118 | **all green**: guard, top-up, pick, sign in, donation (typed 1 → page 1.0963 USDC → `donated()` +1.0963), indexed (API 2192600 = chain) | — |

## 061c — crew marking, step 1: migration `0026` (2026-11-25)
Expand first (HANDOFF rule): this PR adds only the column — SQL, journal, snapshot. `packages/db/src/schema/users.ts` is unchanged, so the code running on dev (`select()` on `users`) does not see the column yet. The code PR (crew registry in `@cherrio/shared`, flag set at login on dev, `is_demo` for the crew's organisations and campaigns) follows after this one is deployed.

- `packages/db/drizzle/0026_users_is_agent.sql` — `ALTER TABLE "app"."users" ADD COLUMN "is_agent" boolean DEFAULT false NOT NULL;`
- snapshot generated by adding `isAgent` to `users.ts`, `pnpm db:generate --name users_is_agent`, then reverting the `.ts`.

### Test results (this session)
- `pnpm --filter @cherrio/db migrate` → `Migrations complete.`; `\d app.users` shows `is_agent | boolean | | not null | false`.
- `pnpm --filter @cherrio/db test:integration` → `Tests 19 passed (19)` (no new table, so the expected-table list is unchanged).
- `pnpm --filter web test` before the change → `Tests 636 passed (636)`; the column is invisible to the code until the next PR.

### docs/technical chapters updated
- 03 (`users` row: `is_agent`, Built).

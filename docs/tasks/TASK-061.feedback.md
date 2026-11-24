# TASK-061 feedback
Status: PARTIAL — 061a done; 061b–f open

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

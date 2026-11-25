# Amoy-dev redeploy with the ADR-061 contracts — feedback
Status: DONE in code; live once the switch PR's Deploy is green and the reset has run on dev

## What happened
- 2026-11-24, first attempt by David: the run hung on its first transaction for 24 minutes and ended with "connection reset". Cause: `--with-gas-price 35gwei --priority-gas-price 30gwei` from CHEATSHEET §7.2 — with an Amoy base fee of ~31 gwei the cap left ~4 gwei of priority, below what Amoy validators take (~25 gwei). The old values worked on 2026-10-01 when the base fee was low.
- 2026-11-25, second run (`--with-gas-price 150gwei --priority-gas-price 40gwei`, no `--resume`): `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`, 11 transactions, 0.3699 POL, all 5 contracts verified on Polygonscan and Sourcify. Output pasted by David in the project chat.

| Contract | Address |
|---|---|
| PlatformConfig | `0xFdC7134BDcE8e3Ed07322eD1F90DA15297ca5e0B` |
| Campaign implementation | `0x2C1F9AA8FCD1a990D12A5Bdbd8C79dF19b3ED3c6` |
| CampaignFactory | `0x30594D1B207d6101a82Bf2A89da622FB26E5a0B5` |
| EmergencyPool | `0x3a108a45BdD0843612Bd55C2797B1147f06223bD` |
| TimelockController (300 s) | `0x725e30EfCc66f65257130b4C63c8e986d4b3351d` |

Start block 53772218, commit `6b4ae41`. The addresses moved up by one nonce against the first dry run, so the first attempt's PlatformConfig transaction did land (an unused PlatformConfig at `0xbdB2846A733faa3dBb7e405854408018ee81997B`, admin = the testnet EOA, referenced nowhere).

## What I changed
- `packages/contracts/deployments/amoy-dev.json` — the new addresses (David sent the file; he did not commit it).
- Tests that compare with the dev deployment: new addresses and start block. Not changed on purpose: `packages/shared/test/campaign-address.test.ts` and the `cast` reference in `contract-config-params.test.ts` (fixed inputs of precomputed results, not the live deployment).
- **New:** `apps/web/src/lib/campaigns/redeploy.ts` + `apps/web/scripts/campaigns.ts`, bundled as `apps/web/dist/campaigns.mjs` (Dockerfile; CI checks the bundle loads in the image). `reset-after-redeploy [--apply]` puts DEPLOYED campaigns whose address is not the current factory's prediction for their offchainId back to APPROVED (address, publish hash, deadline, deployed-at cleared; the old contract's evidence bundles and their file rows deleted — the files themselves go with the storage sweep; audit `campaign.reset_after_redeploy` with `evidenceBundlesRemoved`). Pure check, so it does not depend on the indexer. Refused on prod and on chain 137 (old mainnet campaigns must finish on their own contracts, ADR-009).
- Docs: CHEATSHEET §7 table, §7.2 gas values + troubleshooting + step 9 "after the switch"; technical 02 (§9 table, deployed values, known-limitation labels), 08 (operations table), 09; owner guide **v1.16** (§2 addresses, §8 "After the test contracts are deployed again") + PDF.

## Why the reset is needed
The live list joins `chain.campaign`, so old campaigns disappear from it by themselves, but their own pages (left join) stay reachable and their donate box would point at a clone of the old factory. Without the reset they also cannot be published again (publishing needs APPROVED).

## Test results (this session)
- `pnpm --filter web exec vitest run src/__tests__/campaign-redeploy.test.ts` → 4 passed.
- Independent read-only reviewer (subagent) on the diff: one MEDIUM — an old round-0 evidence bundle (unique per campaign and round) would block the new contract's round 0 and name the old address → fixed (bundles removed in the reset, test + deliberate break: `--apply puts them back…` failed with the cleanup disabled). LOWs: refuse chain 137 too → done; APPROVED campaigns that kept an old publish hash still show "publishing" → not touched on purpose (a hash sent to the new factory after the switch looks the same), preparing again works; ratings stay per (campaign, user), so donors of the old contract cannot rate the re-published campaign again → accepted on the testnet.
- Deliberate breaks: comparing with the checksummed prediction → 2 failed (`a dry run lists only…`, `--apply puts them back…`); prod guard removed → 1 failed (`is refused on prod…`); both restored → 4 passed.
- Bundle: `node campaigns.mjs` → usage, exit 1; `APP_ENV=prod … reset-after-redeploy` → "Refused: never on prod", exit 1; `APP_ENV=dev` against the local DB → "Current CampaignFactory: 0x30594D…a0B5 … 0 campaign(s) from an earlier deployment", exit 0.
- Full suites: see the PR.

## Not done / open
- The reset is run by David on the server after the Deploy (one `docker exec` line, CHEATSHEET §7.2 step 9).
- Test USDC that donors left in old campaign contracts stays there; refunds are possible only directly on Polygonscan.
- Proof of Charity points and ratings given on old campaigns stay (history); a donor who rated the old campaign cannot rate the re-published one again.

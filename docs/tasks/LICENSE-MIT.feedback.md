# LICENSE-MIT feedback: MIT for the whole repository, plus AI-use disclosure
Status: DONE (merge waits for David's answer on the proprietary wallet SDKs, see "Open questions")

Task given by David on 2026-10-03 (attachment "Release the whole web3-platform repo under the MIT licence", with an addendum on AI-use disclosure per the NLnet GenAI policy). Implemented by the cloud CTO session.

## What I implemented
- `LICENSE`: standard MIT text, "Copyright (c) 2026 Data Vallis d.o.o.".
- `TRADEMARKS.md`: MIT covers code only. Names, logos, wordmarks, symbol and token logo are reserved, and forks must rebrand. It lists every brand file (below).
- `THIRD_PARTY_NOTICES.md`: the vendored submodules, the fonts (OFL 1.1, fetched at build, not in the repo), and every npm production dependency whose licence carries conditions, including the proprietary wallet SDKs and the notices they require.
- `"license": "MIT"` in all 10 `package.json` files (root, `apps/*`, `packages/*`). `"private": true` is unchanged everywhere, and `pnpm install --frozen-lockfile` → "Done", so the lockfile is unchanged.
- **Solidity:** all 22 first-party files under `packages/contracts/{src,script,test}` already had `// SPDX-License-Identifier: MIT` as their first line (checked file by file). No `.sol` file changed, and vendored `lib/` is untouched.
- `README.md`: MIT badge and a "Licence" section that links LICENSE, TRADEMARKS, THIRD_PARTY_NOTICES, CONTRIBUTING and AI-USE.
- `CONTRIBUTING.md`: new "Licence of contributions" section (inbound = outbound MIT; PRs into `dev`; CI must pass). The file already existed, and the rest is unchanged.
- `AI-USE.md` (addendum): sources of the concept and rules, the spec-as-prompt process, generation with Anthropic Claude, CI gates, the review and merge rules (including the autonomous dev merges), feedback files, commit marking (`Co-Authored-By` trailer plus a `Prompt:` line), and the licence.
- `CLAUDE.md` (cloud section) and `docs/00-MANIFEST.md` §6: the commit-marking rule.
- **Docs:**
  - ADR-044 in `docs/03-DECISIONS.md`;
  - FAQ Q31 in `docs/technical/10` rewritten;
  - `docs/technical/07` (the "private repository" wording on CI triggers);
  - `docs/technical/09` (new "Source code" row; indexer row now mentions the campaign pages and the 60 s polling).
- **Also in this PR:** the TASK-011a status labels are flipped to "Live on dev" in `03`, `04` and `09`. PR #50 is merged, and Deploy run 37124413963 succeeded.

## Brand assets excluded from MIT
- `apps/web/public/brand/`: `apple-touch-icon.png`, `favicon.svg`, `cherrio-wordmark-ink.svg`, `cherrio-wordmark-white.svg`
- `packages/ui/design-system/assets/files/`:
  - `cherrio-symbol-{cherry,gradient,ink,white}.svg`;
  - `cherrio-wordmark-{cherry,ink,white}.svg`, `cherrio-wordmark-gradient.png`;
  - `chr-token-1024.png`.
- `docs/tasks/screenshots/**`: interface screenshots that show the brand.

## Deployed contracts
The amoy-dev contracts were **not** redeployed. Their verified source on Polygonscan already carries `SPDX-License-Identifier: MIT`, because no SPDX line changed in this task. Changing an SPDX comment would only change the metadata hash of future deployments, and that question does not arise here.

## Licence report (`pnpm licenses list --prod --json`, whole workspace, 820 packages)
| Count | Licence |
|---|---|
| 592 | MIT |
| 108 | Apache-2.0 |
| 40 | ISC |
| 22 | "Unknown" in the report; resolved by hand (below) |
| 20 | BSD-3-Clause |
| 9 | MPL-2.0 |
| 9 | BSD-2-Clause |
| 7 | BlueOak-1.0.0 |
| 2 | LGPL-3.0-or-later (`@img/sharp-libvips-linux-x64`, `-linuxmusl-x64`) |
| 2 | Unlicense |
| 2 | 0BSD |
| 1 each | (MIT OR Apache-2.0), Python-2.0 (`argparse`), CC-BY-4.0 (`caniuse-lite`), (Apache-2.0 AND MIT), LGPL-3.0-only (`rpc-websockets`), (MIT AND BSD-3-Clause), (MIT OR CC0-1.0) |

The 22 "Unknown" entries, resolved from the packages' own files:
- `eyes` is MIT, `text-encoding-utf-8` is public domain, and `@privy-io/api-base` is Apache-2.0. These are fine.
- `@metamask/eth-json-rpc-provider` has no licence file in the package; the upstream repository is ISC.
- **Flagged, non-OSS:**
  - `@walletconnect/*` (core, sign-client, universal-provider, ethereum-provider, types, utils) are under the **WalletConnect Community License** (Reown, Inc.);
  - `@reown/appkit*` (9 packages) are under the **Reown Community License**;
  - `@metamask/sdk`, `sdk-communication-layer` and `sdk-install-modal-web` are under the **ConsenSys proprietary licence**.

There is **no GPL, AGPL, SSPL or BUSL licence** among production dependencies. The LGPL and MPL packages are used unmodified as separate modules and do not affect licensing our code under MIT.

## Test results (real, this session)
- **Foundry** (installed in the sandbox for this task: forge 1.5.1-stable; solc 0.8.24 from the GitHub release, run with `--offline`, because the solc download host is blocked):
  - `forge fmt --check` → exit 0;
  - `forge build` → ok;
  - `forge test` → `Ran 9 test suites in 18.91s (30.93s CPU time): 251 tests passed, 0 failed, 0 skipped (251 total tests)`.
  - The task expected "241 or the current count". The current count is **251**: 241 at DEPLOY-AMOY, plus tests added later. No contract code changed here.
- `pnpm --filter web test` → `Test Files 28 passed (28)`, `Tests 197 passed (197)`.

## Files changed
`LICENSE`, `TRADEMARKS.md`, `THIRD_PARTY_NOTICES.md`, `AI-USE.md` (new); `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`; 10 × `package.json`; `docs/00-MANIFEST.md`, `docs/03-DECISIONS.md`; `docs/technical/03`, `04`, `07`, `09`, `10`; this feedback file.

## Deviations
- No `.sol` edits, because none were needed.
- `CONTRIBUTING.md` already existed, so it got a section instead of being replaced.
- The TASK-011a label flip is bundled here to save a separate docs PR.

## Open questions / risks (for David)
1. **Proprietary wallet SDKs (the task said: stop and ask).** `@privy-io/react-auth` depends on the WalletConnect/Reown SDKs and the MetaMask SDK. These do **not** prevent releasing our code under MIT: they are not in the repository, and their terms bind the operator of a running service, not our source licence. They do carry operator obligations:
   - **WalletConnect/Reown:** free up to 500 MAU / 2.5 M RPC calls a month, then a commercial licence; attribution "Portions © 2025 Reown, Inc."; use of the Reown network.
   - **MetaMask SDK:** free for charitable organisations or up to 10,000 MAU; requires a notice.
   - NLnet reviewers may also ask about non-OSS runtime dependencies.
2. **AI-USE.md says what we actually do.** In the autonomous cloud mode the AI merges into `dev` on green CI, and David reviews on dev and promotes to uat/prod. If you want "every merge reviewed by David before merge" to be literally true for NLnet, the working mode would have to change.

## Suggested commit message
docs(license): release the repository under MIT; brand excluded; AI-use disclosure

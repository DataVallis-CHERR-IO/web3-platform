# Third-party notices

CHERR.IO's own code is MIT-licensed ([LICENSE](LICENSE)). The third-party software and fonts it uses keep their own licences; nothing in this repository relabels them. This page lists what is vendored or shipped and every licence that is not a plain permissive one. Last checked: 2026-10-03 (`pnpm licenses list --prod`).

## Vendored in this repository

| Component | Where | Licence |
|---|---|---|
| forge-std | `packages/contracts/lib/forge-std` (git submodule) | MIT OR Apache-2.0 |
| OpenZeppelin Contracts | `packages/contracts/lib/openzeppelin-contracts` (git submodule) | MIT |
| Simple Icons 13.21.0 — five SVG paths (X, Facebook, LinkedIn, WhatsApp, Telegram) | `apps/web/src/components/campaigns/share-icons.ts` | CC0-1.0 (the brand marks belong to their owners; used only on links that share to that network) |

## Fonts

Archivo, Archivo Black and IBM Plex Mono are licensed under the **SIL Open Font License 1.1**. For the web pages they are not stored in this repository: `next/font/google` downloads them at build time and the web app serves them itself.

The link preview images (TASK-055b) need font files at run time, so six WOFF files of **Archivo** (400, 700) and **Archivo Black** (400), Latin and Latin Extended, are stored in `apps/web/public/fonts/` with their licence texts (`OFL-Archivo.txt`, `OFL-ArchivoBlack.txt`). They were taken unchanged from the npm packages `@fontsource/archivo` 5.3.0 and `@fontsource/archivo-black` (OFL 1.1).

## npm dependencies (not stored in the repository)

Production dependencies are installed by `pnpm install` and are part of the built web app and the Docker images. Most are MIT, Apache-2.0, ISC or BSD (see `docs/tasks/LICENSE-MIT.feedback.md` for the counts). The packages below have licences that carry extra conditions:

| Package(s) | Comes in through | Licence | What it means for us |
|---|---|---|---|
| `@img/sharp-libvips-*` | `sharp` (image re-encoding) | LGPL-3.0-or-later | Dynamically linked native library, used unmodified. |
| `rpc-websockets` | `@privy-io/react-auth` → Solana client | LGPL-3.0-only | Used unmodified as a separate module. |
| `axe-core`, `@axe-core/playwright`, `lightningcss`, `@ethereumjs/*`, `webextension-polyfill` | tooling and wallet libraries | MPL-2.0 | File-level copyleft. Applies only if we modify those files; we do not. |
| `caniuse-lite` | build tooling | CC-BY-4.0 | Data attribution. |

## Runtime dependencies with non-OSI or usage-limited terms

These packages are **not part of this repository** and are **not relicensed under MIT**. They are installed transitively through `@privy-io/react-auth` (3.46.0) and end up in the built web app. **Anyone who deploys the app must comply with their terms**, Data Vallis included. Versions are taken from `pnpm-lock.yaml` on 2026-10-03.

| Package (version) | Path | Licence | Terms in short |
|---|---|---|---|
| `@reown/appkit`, `-common`, `-controllers`, `-pay`, `-polyfills`, `-scaffold-ui`, `-ui`, `-utils`, `-wallet` (all **1.8.9**) | `@privy-io/react-auth` → `@walletconnect/ethereum-provider` 2.22.4 → `@reown/appkit` 1.8.9 | Reown Community License ([text](https://raw.githubusercontent.com/reown-com/appkit/main/LICENSE.md)) | Free up to **500 MAU** or 2.5 M RPC calls a month. Every connected external wallet *and every embedded wallet created* counts as an MAU. Above that, a commercial licence is required. Attribution "Portions © 2025 Reown, Inc. All Rights Reserved" and a copy of the licence must come with the product, and use of the Reown network is mandatory. |
| `@walletconnect/core`, `sign-client`, `types`, `universal-provider`, `utils` (**2.21.9** and **2.22.4**), `@walletconnect/ethereum-provider` (**2.22.4**) | `@privy-io/react-auth` → `@walletconnect/ethereum-provider` 2.22.4 → … | WalletConnect Community License ([text](https://raw.githubusercontent.com/WalletConnect/walletconnect-monorepo/v2.0/LICENSE.md)) | Same terms as Reown above. |
| `@metamask/sdk` (**0.33.1**), `@metamask/sdk-communication-layer` (**0.33.1**), `@metamask/sdk-install-modal-web` (**0.32.1**) | `@privy-io/react-auth` → `x402` 0.7.3 → `wagmi` 2.19.5 → `@wagmi/connectors` 6.2.0 → `@metamask/sdk` 0.33.1 | ConsenSys proprietary licence ([text](https://raw.githubusercontent.com/MetaMask/metamask-sdk/main/LICENSE)) | Free for "non-commercial use", which includes use by **charitable organisations** or products with up to **10,000 MAU**. Requires a notice that the program is used and is © ConsenSys Software Inc. |

Older copies of the same families in the lockfile (`@reown/appkit*` 1.7.8, `@walletconnect/*` 2.21.0/2.21.1) are Apache-2.0. The small `@walletconnect/*` helpers (`events`, `jsonrpc-*`, `relay-*`, `time`, `logger` …) and `@metamask/sdk-analytics` are MIT.

The notices are shown in the app on **`/en/licences`**, which is linked from the footer:
- Portions © 2025 Reown, Inc. All Rights Reserved.
- This product uses the MetaMask SDK, © ConsenSys Software Inc.

None of these licences applies to CHERR.IO's own source code, and none prevents releasing that code under MIT. Whether to obtain a commercial Reown licence, rely on an exemption, or disable WalletConnect-based connectors in Privy is an open operator decision before production (`docs/technical/08-operations.md` §10).

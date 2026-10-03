# Third-party notices

CHERR.IO's own code is MIT-licensed ([LICENSE](LICENSE)). The third-party software and fonts it uses keep their own licences; nothing in this repository relabels them. This page lists what is vendored or shipped and every licence that is not a plain permissive one. Last checked: 2026-10-03 (`pnpm licenses list --prod`).

## Vendored in this repository

| Component | Where | Licence |
|---|---|---|
| forge-std | `packages/contracts/lib/forge-std` (git submodule) | MIT OR Apache-2.0 |
| OpenZeppelin Contracts | `packages/contracts/lib/openzeppelin-contracts` (git submodule) | MIT |

## Fonts

Archivo, Archivo Black and IBM Plex Mono are licensed under the **SIL Open Font License 1.1**. They are not stored in this repository: `next/font/google` downloads them at build time and the web app serves them itself.

## npm dependencies (not stored in the repository)

Production dependencies are installed by `pnpm install` and are part of the built web app and the Docker images. Most are MIT, Apache-2.0, ISC or BSD (see `docs/tasks/LICENSE-MIT.feedback.md` for the counts). The packages below have licences that carry extra conditions:

| Package(s) | Comes in through | Licence | What it means for us |
|---|---|---|---|
| `@walletconnect/*` (core, sign-client, universal-provider, ethereum-provider, types, utils) | `@privy-io/react-auth` (external-wallet connection) | **WalletConnect Community License** (Reown, Inc.; proprietary, not OSI) | Free below the stated thresholds (500 monthly active users / 2.5 M RPC calls a month at the time of writing); a commercial licence is required above them. Requires the notice "Portions © 2025 Reown, Inc. All Rights Reserved" and a copy of the licence with the product, and use of the Reown network. |
| `@reown/appkit*` | `@walletconnect/ethereum-provider` | **Reown Community License** (proprietary, not OSI) | Same model as above. |
| `@metamask/sdk`, `@metamask/sdk-communication-layer`, `@metamask/sdk-install-modal-web` | `@privy-io/react-auth` | ConsenSys proprietary licence (not OSI) | Non-commercial use is free; charitable organisations and products up to 10,000 monthly active users count as non-commercial. Requires a notice that the program is used and is © ConsenSys Software Inc. |
| `@img/sharp-libvips-*` | `sharp` (image re-encoding) | LGPL-3.0-or-later | Dynamically linked native library, used unmodified. |
| `rpc-websockets` | `@privy-io/react-auth` → Solana client | LGPL-3.0-only | Used unmodified as a separate module. |
| `axe-core`, `@axe-core/playwright`, `lightningcss`, `@ethereumjs/*`, `webextension-polyfill` | tooling and wallet libraries | MPL-2.0 | File-level copyleft. Applies only if we modify those files; we do not. |
| `caniuse-lite` | build tooling | CC-BY-4.0 | Data attribution. |

None of these licences applies to CHERR.IO's own source code, and none prevents releasing that code under MIT. The proprietary wallet SDKs above are runtime dependencies of Privy. Their terms bind whoever **operates** a service built with them, whether Data Vallis or a fork.

Notices required by those SDKs, for the operated service:
- Portions © 2025 Reown, Inc. All Rights Reserved.
- This product uses the MetaMask SDK, © ConsenSys Software Inc.

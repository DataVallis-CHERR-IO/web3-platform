# LedgerTable

**Proof layer only.** The public ledger: every donation or payout as a row, newest first, each linking to Polygonscan (↗). Mono, USDC with 2 decimals, right-aligned amounts, hairline dividers; scrolls sideways inside its own box on mobile. Lives in the page's `#proof` section under the heading "Every donation, on the blockchain".

Consumer provides: `rows` `[{time, from, label?, amount, tx}]`, `explorerBase` (Amoy: `https://amoy.polygonscan.com/tx/`), optional `caption`.

**TASK-011a additions:** `fromDisplay` per row shows a donor's name (or "Anonymous") instead of the truncated address (ADR-043; the full address stays in `title`); `txAriaLabel(shortTx)` translates the tx link's accessible name; `explorerBase: null` renders hashes without links (local chain); the scroll wrapper is a focusable `role="region"` named by `regionLabel` (falls back to `caption`) with a focus ring, so keyboard users can scroll the table on narrow screens (axe `scrollable-region-focusable`).

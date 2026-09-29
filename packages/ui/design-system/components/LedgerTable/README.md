# LedgerTable

**Proof layer only.** The public ledger: every donation or payout as a row, newest first, each linking to Polygonscan (↗). Mono, USDC with 2 decimals, right-aligned amounts, hairline dividers; scrolls sideways inside its own box on mobile. Lives in the page's `#proof` section under the heading "Every donation, on the blockchain".

Consumer provides: `rows` `[{time, from, label?, amount, tx}]`, `explorerBase` (Amoy: `https://amoy.polygonscan.com/tx/`), optional `caption`.

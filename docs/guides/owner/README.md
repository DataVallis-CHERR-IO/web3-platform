# Contracts owner guide

PDF guide for the owners of CHERR.IO (today David, Data Vallis d.o.o.): what the smart contracts let the owner change, what each setting means, allowed values, roles, how long a change takes, and how to use **Admin → Contracts** (TASK-034, ADR-046).

| File | What it is |
|---|---|
| `contracts-owner-guide.md` | **The source.** Front matter (title, version, date, file name) + one `## N. Title` per chapter. |
| `dist/CHERR.IO-Contracts-Owner-Guide-v<version>.pdf` | The built PDF (committed, so it can be downloaded from GitHub). Never edit it. |

Build (uses the whitepaper's design and build script):

```bash
cd docs/whitepaper
npm install            # once
npm run owner-guide    # -> docs/guides/owner/dist/<filename from front matter>
```

## Maintenance rule (David, 2026-10-04)

Every pull request that changes the contracts, their roles or deployment, or Admin → Contracts also:
1. updates `contracts-owner-guide.md` (facts, screens, numbers);
2. raises `version` and `filename` in its front matter;
3. adds a line to the change log below;
4. rebuilds the PDF and commits it (the old PDF is removed).

## Change log

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-10-04 | First version: contracts, roles, timelock delays, every PlatformConfig setting, Admin → Contracts step by step, 1-hour test vote window example, manual fallback, troubleshooting (TASK-034b). |
| 1.1 | 2026-10-04 | MetaMask only signs; checks, fees and confirmations are read by CHERR.IO (`/api/rpc`). New messages "Transaction sent…" and "…confirmation could not be read yet", "Something went wrong" row, §7 clarifies the 5-minute wait vs the 1-hour vote window (fix/contract-console-reads). |

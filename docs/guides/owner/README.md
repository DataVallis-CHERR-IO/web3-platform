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

Every pull request that changes the contracts, their roles or deployment, Admin → Contracts or the admin chain actions also:
1. updates `contracts-owner-guide.md` (facts, screens, numbers);
2. raises `version` and `filename` in its front matter;
3. adds a line to the change log below;
4. rebuilds the PDF and commits it (the old PDF is removed).

## Change log

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-10-04 | First version: contracts, roles, timelock delays, every PlatformConfig setting, Admin → Contracts step by step, 1-hour test vote window example, manual fallback, troubleshooting (TASK-034b). |
| 1.1 | 2026-10-04 | MetaMask only signs; checks, fees and confirmations are read by CHERR.IO (`/api/rpc`). New messages "Transaction sent…" and "…confirmation could not be read yet", "Something went wrong" row, §7 clarifies the 5-minute wait vs the 1-hour vote window (fix/contract-console-reads). |
| 1.2 | 2026-10-04 | §8: payout plan, Guardian decisions, freeze and unfreeze on the admin campaign page and Admin → Chain actions, step by step, with what each call does on the contract (TASK-033d). |
| 1.3 | 2026-10-04 | §8: "When nobody acted: CHERR.IO steps in" — finish a campaign 7 days after its deadline, count a vote 7 days after it ended, move unclaimed refunds to the Emergency Pool after the refund window; sent from any admin wallet, no role (TASK-033f, ADR-050). |
| 1.4 | 2026-10-05 | §8: demo campaigns on the test network — Admin → Demo campaigns, "Publish all" with one Operator confirmation per campaign, up to 10 per round; not available on uat/prod (TASK-038c, ADR-052). |
| 1.5 | 2026-10-05 | §8 demo campaigns follow the production flow: demo organisations with their own member start the campaigns, approved or in review; the admin is never a member (TASK-040a, ADR-053). |
| 1.6 | 2026-10-05 | §8 cover images: choice between FLUX.2 [pro] (default, cheaper) and Nano Banana Pro (TASK-043). |
| 1.7 | 2026-10-05 | §8: create the Emergency Pool sub-pools in Admin → Emergency Pool sub-pools (Operator, one confirmation per theme) instead of Polygonscan; the five theme rows now come with every deploy (TASK-046). |
| 1.8 | 2026-10-07 | §1 and §10: admin sign-in with an authenticator app — set-up with a QR code, ten recovery codes, a code every 12 hours, reset with `reset-admin-mfa` when the phone and the recovery codes are lost (TASK-049, ADR-056). |
| 1.9 | 2026-10-09 | §8: the menu item is now "Emergency Pool"; §10: the admin menu on every admin page and **Admin → Audit log** — what it shows, its filters, the "Audit log of this record" links, and what to look for after a reset (TASK-021). |

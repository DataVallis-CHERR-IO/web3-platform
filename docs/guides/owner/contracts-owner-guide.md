---
# Source of the CHERR.IO contracts owner guide (TASK-034, ADR-046).
# Build: cd docs/whitepaper && npm install && npm run owner-guide  -> docs/guides/owner/dist/<filename>
# Keep it true: every change to the contracts, their roles, the deploy scripts or Admin → Contracts
# updates this file in the same PR, with a new version and a line in the change log (docs/guides/owner/README.md).
title: Contracts owner guide
headline: Running the CHERR.IO smart contracts safely
version: "1.6"
date: October 2026
publisher: Data Vallis d.o.o., Slovenia
website: cherr.io
filename: CHERR.IO-Contracts-Owner-Guide-v1.6.pdf
---

# About this guide {.abstract}

**For the owners of CHERR.IO.** This guide explains what the CHERR.IO smart contracts let their owners change, what every setting means, which values are allowed, who may do what, and how long a change takes. It is written for the platform admin who holds the owner wallet (today David Tacer, Data Vallis d.o.o.). It follows the code in the public repository (`packages/contracts`, `apps/web/src/lib/contracts`) and decisions ADR-009, ADR-025, ADR-045, ADR-046 and ADR-050. If this guide and the code disagree, the code is right and this guide must be corrected.

## 1. The short version

- Platform settings live in one contract, **PlatformConfig**. You change them on CHERR.IO under **Admin → Contracts**, in normal units: percent, minutes, hours, days, USDC.
- No setting changes at once. Every change goes through the **timelock**: you *schedule* it, wait, then *apply* it. On the test network (Amoy) the wait is **5 minutes**; on the main network it will be **48 hours**. Everyone can see a scheduled change on the blockchain before it happens.
- A change applies only to **campaigns and Emergency Pool votes created after it is applied**. A running campaign keeps the values it started with, for its whole life.
- Your wallet signs everything. CHERR.IO's server holds no key and cannot change anything on its own.
- The contracts cannot be upgraded and cannot send money to an address of your choosing. The owner powers are limited to the settings and decisions in this guide.

::: note What you need
A computer with MetaMask (or another wallet CHERR.IO supports), the owner wallet imported in it, and a little POL in that wallet for network fees. On Amoy, test POL comes from a faucet.
:::

## 2. The contracts

| Contract | What it does | Changeable? |
| --- | --- | --- |
| **PlatformConfig** | Holds every platform setting and the list of who has which role. | Settings: yes, through the timelock. |
| **TimelockController** | The owner of PlatformConfig. Executes a change only after the waiting time. | Its waiting time is fixed at deployment. |
| **CampaignFactory** | Creates one campaign contract per approved campaign. | No settings. |
| **Campaign** (one per campaign) | Holds the donations of one campaign: payouts, votes, refunds. Copies the settings when it is created. | Never. |
| **EmergencyPool** | Holds the Emergency Pool and its themed sub-pools; moves money to campaigns only by vote. | No settings. |

Current addresses on the test network (dev, Polygon Amoy, chain 80002):

| Contract | Address |
| --- | --- |
| PlatformConfig | `0x4d2570ccB2a6653D62a002027C0d383FfB193A16` |
| TimelockController | `0x52ba2090E62c9155c04E7E5f28DB9Af00A6AAede` |
| CampaignFactory | `0xd5Ca76A8FC6E15C6cC3F3C691A2b6c70D9715a00` |
| EmergencyPool | `0xFa7Fd0253813E196d74575A8F93ABB91cd009517` |

The main network addresses are added here when the contracts are deployed there. The source of truth is `packages/contracts/deployments/`.

## 3. Roles: who may do what

| Role | Held by | May do | Speed |
| --- | --- | --- | --- |
| **Proposer** (timelock) | The Safe | Schedule a settings change. | Change waits the timelock delay. |
| **Executor** (timelock) | The Safe | Apply a scheduled change once it is ready. | — |
| **Canceller** (timelock) | The Safe | Cancel a scheduled change before it is applied. | Immediate. |
| **Admin** (PlatformConfig) | The timelock itself | Every settings function and every role grant. Nobody calls these directly. | Only through the timelock. |
| **Operator** | The Safe | Publish an approved campaign (CampaignFactory), set a campaign's payout mode, create Emergency Pool sub-pools, propose Emergency Pool allocations. | Immediate. |
| **Guardian** | The Safe | Freeze a campaign; decide a campaign or allocation under review (approve or reject). | Immediate, no timelock. |

On Amoy the "Safe" is a single test wallet, `0x4326…B5a7`, so that one wallet holds every role (ADR-025). On the main network it will be a Gnosis Safe multisig.

::: note The Guardian cannot take money
Freezing stops a campaign; resolving moves it to the next step or rejects it, after which donors get their money back or send it to the Emergency Pool, as each of them chose. No owner role can send funds anywhere else.
:::

## 4. How fast a change happens

| Action | Test network (Amoy) | Main network |
| --- | --- | --- |
| Settings change (schedule → apply) | at least **5 minutes** | at least **48 hours** |
| Cancel a scheduled change | at once | at once |
| Guardian freeze or review decision | at once | at once |
| Publish a campaign, set payout mode | at once | at once |

The waiting time is the timelock's *minimum delay*. It is shown on Admin → Contracts under "Waiting time before a change can be applied". On the main network it is fixed at 48 hours in the deployment script and cannot be shortened.

After a change is applied, **new** campaigns use it. A campaign created before keeps the old value until it ends. Example: if you shorten the vote window to 1 hour today, a campaign published yesterday still gives its donors the old window.

## 5. Every setting explained

| Setting | What it means | You enter | Allowed | Default |
| --- | --- | --- | --- | --- |
| **Platform fee** | Share of each payout that goes to the CHERR.IO fee wallet. | percent, up to 2 decimals | 0 – 5 % | 1 % |
| **Success threshold** | Share of the target a campaign must raise by its deadline to succeed. Below it, donors get their money back. | percent | 0.01 – 100 % | 10 % |
| **Vote window** | How long donors can vote on a payout step after the fundraiser submits evidence. | number + minutes / hours / days | 1 hour – 14 days | 7 days |
| **Quorum** | Share of the donated amount that must take part in a vote. Below it, the vote goes to the Guardian. | percent | 0.01 – 100 % | 25 % |
| **Approval** | Share of the votes cast that must say yes for the next payout. | percent | more than 50 %, up to 100 % | 51 % |
| **Unclaimed refunds kept for** | After this time, refunds nobody claimed can be moved to the Emergency Pool. | number + days | 30 – 365 days | 180 days |
| **Minimum donation** | The smallest donation a campaign accepts. | USDC, up to 6 decimals | more than 0 | 1 USDC |
| **Wait before a single payout** | Time between the end of a campaign and its one-time payout, so the Guardian can step in. | number + minutes / hours / days | 0 – 7 days | 3 days |
| **Fee wallet** | Address that receives the platform fee. | address | any address except zero | set at deployment |
| **Emergency Pool contract** | Address of the Emergency Pool. Change only when a new pool contract is deployed. | address | any address except zero | set at deployment |

"Default" is the value in the contract source (ADR-045). A contract deployed earlier keeps the values it was deployed with until you change them: the Amoy PlatformConfig was deployed with a 24-hour vote window and a 50 % quorum. Admin → Contracts always shows the live value under "Now".

**Votes in plain numbers.** With a 25 % quorum and 51 % approval, a campaign that raised 1,000 USDC needs donors holding at least 250 USDC of it to vote, and more than half of the voted amount to say yes. Each donor's vote weighs as much as they donated. If nobody votes, or too few, the Guardian decides — silence is never counted as yes (ADR-045).

**On-chain units.** The contract stores percent as *basis points* (1 % = 100), times in *seconds* and USDC in *millionths* (1 USDC = 1,000,000). The console converts for you and shows the exact stored number in brackets, for example "25% (2500)".

## 6. Changing a setting, step by step

1. **Open the console.** Log in to CHERR.IO with your admin account, open **Admin → Contracts**. The page shows the network, the contract addresses, the waiting time and every setting with its current value.
2. **Connect the owner wallet.** Connect MetaMask with the owner wallet. Under "Setup" the page lists your wallet and its roles; you need *can schedule changes* and *can apply changes*. If it says "no role on these contracts", you are using the wrong wallet.
3. **Type the new values.** Change one or more fields. For times, pick the unit (minutes, hours, days). A field outside the allowed range turns red and says the lowest or highest allowed value. Under a changed field you see "Will be …".
4. **Review.** Press **Review N changes**. A table shows each setting with "Now" and "New", in words and as the stored number. Read it carefully.
5. **Schedule.** Press **Schedule the change** and confirm in MetaMask. The page says "Transaction sent. Waiting for the network to confirm it…" and then "The change is scheduled". The change now waits in the timelock, visible to everyone. It appears under **Scheduled changes** with the time from which it can be applied. MetaMask only signs: every check before and after (your roles, the network fee, the confirmation) is read by CHERR.IO itself, so a slow MetaMask network connection does not stop the console.
6. **Wait.** 5 minutes on Amoy, 48 hours on the main network. You can close the page.
7. **Apply.** Come back. When the change says **Ready to apply**, press **Apply the change** and confirm in MetaMask. The new value appears under "Now". Done.

To withdraw a scheduled change, press **Cancel** next to it and confirm in MetaMask. A cancelled change can never be applied; schedule a new one if needed.

Every step is recorded: who scheduled, applied or cancelled what and when, with the transaction (the console's history and the admin audit log).

::: note Main network: the Safe
On the main network the owner is a multisig Safe, not MetaMask. When no connected wallet may schedule, the review offers **Download for Safe**: a file you import in the Safe app (Transaction Builder) to sign there. Applying works the same way after the 48 hours.
:::

## 7. Example: a 1-hour vote window for testing

On the test network we keep the vote window short so the whole donation → vote → payout flow can be tested in an afternoon (decision of 4 October 2026; the main network stays at 7 days).

1. Admin → Contracts, connect the owner wallet.
2. **Vote window**: type `1`, choose **hours**.
3. **Quorum**: type `25`.
4. **Review 2 changes** → check "1 day → 1 hour" and "50% → 25%" → **Schedule the change** → confirm.
5. After 5 minutes (the timelock waiting time on Amoy — it has nothing to do with the 1 hour you are setting): **Apply the change** under **Scheduled changes** → confirm. Nothing changes until you apply: before that, "Now" still shows 1 day and 50%.
6. Campaigns published from now on have a 1-hour vote. Campaigns published before keep 24 hours.

## 8. Other owner actions

These do not go through the timelock. The campaign actions are on the **admin campaign page** (TASK-033d, TASK-033f); **Admin → Chain actions** lists every campaign that waits for one.

| Action | Role | Where today |
| --- | --- | --- |
| Publish an approved campaign | Operator | Admin → Campaigns → campaign → Publish (signed in your wallet). |
| Publish demo campaigns (test networks only) | Operator | Admin → Demo campaigns → **Publish all N demo campaigns** — up to 10 per round, one confirmation per campaign (ADR-052). |
| Set a campaign's payout mode (single or three milestones) | Operator | Admin → Chain actions → campaign → **Set the payout plan**. Only after the campaign succeeded, only once. |
| Decide a campaign under review | Guardian | Admin → Chain actions → campaign → **Approve — release the next payment** or **Reject — donors get the rest back**. A note is required. |
| Freeze a campaign | Guardian | Admin campaign page → **Freeze the campaign** (note and confirmation required). |
| Unfreeze a campaign | Guardian | Admin → Chain actions → campaign → **Unfreeze — continue where it stopped** (or reject). |
| Finish a campaign nobody finished (7 days after the deadline) | none — any wallet | Admin → Chain actions → "Finish — nobody did for 7 days" → **Finish the campaign** (ADR-050). |
| Count a vote nobody counted (7 days after the vote ended) | none — any wallet | Admin → Chain actions → "Count the votes — nobody did for 7 days" → **Count the votes**. |
| Move unclaimed refunds to the Emergency Pool (after the refund window) | none — any wallet | Admin → Chain actions → "Move unclaimed refunds to the Emergency Pool" → **Move to the Emergency Pool** (confirmation required). |
| Create an Emergency Pool sub-pool | Operator | Polygonscan, EmergencyPool, `createSubPool(id)`. Planned in the pool admin (TASK-014). |
| Propose an Emergency Pool allocation | Operator | Polygonscan, EmergencyPool, `proposeAllocation(…)`. Planned (TASK-014). |
| Decide an allocation under review | Guardian | Polygonscan, EmergencyPool, `resolveAllocation(id, true or false)`. Planned (TASK-014). |
| Grant or revoke a role | Admin (timelock) | Only through the timelock by hand (section 9). Ask the CTO session first. |

### The campaign actions step by step

1. Open **Admin → Chain actions**. Each row says what to do: "Set the payout plan", "Decide the vote", "Frozen — unfreeze or reject", or one of the three steps after nobody acted (below). Click the campaign.
2. The section **On the blockchain — CHERR.IO actions** shows the state, the payout plan, what was raised and paid out, and for a vote the turnout against the campaign's own quorum and the share of yes votes. Under it: the fundraiser's evidence for each round. Private files are downloaded with **Download (recorded in the audit log)**.
3. Connect the wallet with the right role in the header (MetaMask). The page lists your connected wallets and their roles. On Amoy one wallet (0x4326…B5a7) is both Operator and Guardian.
4. Write the note and click the action. The note is saved first, then MetaMask opens. MetaMask only signs; CHERR.IO checks the call against the contract before it opens, so a call the contract would refuse never reaches MetaMask and the page names the reason.
5. After "Sent", the transaction appears under **Notes and transactions** with your note. The state on the page changes when the indexer has seen the transaction (about a minute).

What each action does on the contract:

- **Payout plan.** `setPayoutMode(0)` = one payment, released 72 hours after the end. `setPayoutMode(1)` = three milestone payments; payments 2 and 3 need evidence and a donor vote. It cannot be changed later. An individual's campaign is always milestones; the contract refuses one payment. The page suggests a plan: an organisation's first campaign → one payment (supervised); later campaigns → one payment with a rating of 4.0 or more, milestones below or without a rating. The choice is yours.
- **Decide a vote.** A vote ends in review when turnout is under the quorum or there were no votes (ADR-045: no "silence = consent"). `resolve(true)` releases the next payment; `resolve(false)` rejects the campaign and donors can claim the rest back (or it goes to the Emergency Pool, by their choice).
- **Freeze.** `freeze()` stops everything — donations, votes, payments, refunds — in the states live, succeeded, paying, voting or in review. The contract takes no reason; your note is the record. Use it only for a serious problem (a fraud report, a wrong payout wallet).
- **Unfreeze.** There is no separate unfreeze function: `resolve(true)` on a frozen campaign returns it to the state it was in, and an open vote gets back the time it was frozen. `resolve(false)` rejects it.

### When nobody acted: CHERR.IO steps in (ADR-050)

The people involved start almost every step themselves: the fundraiser or any visitor finishes a campaign after its deadline and counts a vote after it ends; donors claim their own refunds. If nobody does, the campaign appears in **Admin → Chain actions**, and on its page a box **CHERR.IO steps in** shows the one call that is due. There is no key on the server that could do it automatically — an admin sends it from their own wallet.

- **Finish the campaign** — `finalize()`, when the campaign is still running **7 days** after its deadline. The contract decides the result: success when it reached its threshold (10 % of the target), otherwise it fails and donors can get their money back.
- **Count the votes** — `closeVote()`, when a vote ended more than **7 days** ago and nobody counted it. The contract releases the next payment, rejects, or sends the vote to review, exactly as when the fundraiser does it.
- **Move to the Emergency Pool** — `sweepUnclaimed()`, when a failed or rejected campaign's refund window is over (the campaign's own "Unclaimed refunds kept for" value, 180 days by default, counted from the failure or the rejection). Everything still in the campaign goes to the Emergency Pool; donors can no longer claim a refund afterwards, so the page asks you to confirm.

The contract lets anyone call these three functions, so **no role is needed**: any connected wallet works and pays its own small network fee (POL). A note is optional. The 7 days are a rule of the CHERR.IO web app, not a contract setting. Before mainnet we decide whether a server key (or a Safe module) should do this automatically.

### Demo campaigns on the test network (ADR-052)

On dev (and a local machine) **Admin → Demo campaigns** fills the platform with made-up organisations and campaigns for testing, in the same flow as production (ADR-053). It does not exist on uat or production — the server refuses there.

1. Enter how many new demo organisations (0–5; 0 adds campaigns to existing ones) and campaigns per organisation (1–5; at most 10 per batch), whether new campaigns are **approved** or **in review**, your **own test wallet** as payout wallet (payments and evidence of every demo organisation go to and come from it) and the duration: mixed (1, 3, 7, 14, 21, 30 days) or all **1 day**, the shortest the contract allows — for testing payouts quickly. **Create** makes each organisation with its own made-up member, who starts its campaigns; you are never a member, so the four-eyes rule applies as in production. Campaigns in review you approve in Admin → Campaigns. Covers are generated one by one on fal.ai with the model you choose under **Cover images**: **FLUX.2 [pro]** (default, cheaper, about 0.03 $ each) or **Nano Banana Pro** (about 0.15 $ each); the same choice sits next to **Generate missing covers**.
2. Connect the **Operator** wallet (on Amoy 0x4326…B5a7) and click **Publish all N demo campaigns**. For each campaign CHERR.IO prepares the call, and MetaMask asks you to confirm one `createCampaign` transaction — the same call as the single **Publish** button. The wallet's role is checked once per round. Rejecting a transaction in MetaMask stops the round; the rest stay waiting and the button publishes them next time.
3. Each published demo campaign is a real campaign contract on Amoy: donations, votes, refunds and payouts work as for any campaign. It carries a **Demo** tag and a notice on its page. Contracts cannot be deleted, so demo campaigns stay on dev.

## 9. If the console is not available

You can do exactly what the console does on Polygonscan, on the **timelock** contract, tab "Write Contract", connected with the owner wallet:

1. `scheduleBatch` with: *targets* — the PlatformConfig address once per change; *values* — one `0` per change; *payloads* — the encoded setter call per change; *predecessor* — `0x` followed by 64 zeros; *salt* — any unused 32-byte value, e.g. `0x` + 63 zeros + `1`; *delay* — the waiting time in seconds (300 on Amoy).
2. Wait.
3. `executeBatch` with the same targets, values, payloads, predecessor and salt.

The payload of a setter is produced with Foundry: `cast calldata "setVoteWindow(uint32)" 3600`. The console is safer: it checks the allowed ranges, encodes for you and keeps the record. Changes made by hand do not appear in the console's history.

## 10. Checklist and troubleshooting

**Before scheduling**

- Right network in the wallet (Amoy for dev/uat, Polygon for production).
- The review table says what you mean, in words *and* in the stored number.
- You remember that only new campaigns are affected.

**Messages you may see**

| Message | What to do |
| --- | --- |
| "Your wallet is on another network." | Switch the network in MetaMask and try again. |
| "This wallet may not schedule changes." | Connect the owner wallet. |
| "The waiting time is not over yet." | Wait until the change says "Ready to apply". |
| "The wallet does not have enough POL for the network fee." | Send POL to the owner wallet (on Amoy: faucet). |
| "You cancelled in your wallet. Nothing was sent." | Nothing happened; try again if you meant to. |
| "The transaction was sent, but CHERR.IO could not record it." | The change is on the blockchain; keep the transaction link and tell the CTO session so the record can be completed. |
| "Transaction sent, but its confirmation could not be read yet." | The transaction was sent. Open the transaction link; when Polygonscan shows "Success", reload the page — the change is under Scheduled changes. Do not schedule it again. |
| "Something went wrong. Try again." | Nothing was confirmed by the console. If a transaction link is shown, check it first (as above). Otherwise try again; the browser console (F12) shows a line starting with `[contracts]` — send it to the CTO session. |
| "Not found on the blockchain" | The scheduling transaction failed or the change was cancelled; schedule again. |

## 11. Keeping this guide current

The source of this guide is `docs/guides/owner/contracts-owner-guide.md` in the repository. Whenever the contracts, their roles, the deployment or Admin → Contracts change, the same pull request updates this guide, raises its version and adds a line to the change log in `docs/guides/owner/README.md`. The PDF is rebuilt from the source; never edit the PDF.

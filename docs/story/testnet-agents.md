# Story log — AI agents on the CHERR.IO testnet

Source material for a series of posts on X and on LinkedIn (David Tacer). It holds facts, numbers and lessons as they happen. It is not finished copy: each post is written from it and checked by David before it goes out.

Rules for posts made from this file (David):
- Do not advertise that the code is open source.
- Do not say "we wrote the whitepaper" and do not imply the 2018 team.
- Davos hackathon (2018) and the UNECE listing may be mentioned.
- X: 280 characters, English, the CHERR.IO image template (`marketing/X-POST-TEMPLATE.md` in the project).

Last updated: 2026-11-25

---

## 1. The idea in one paragraph

CHERR.IO is a charitable-donations platform on Polygon where every cent is on the record: donations sit in a smart contract per campaign, and money reaches the charity in steps that donors approve. Before mainnet, the public testnet (testnet.cherr.io) has to be used the way real people would use it, every day, without a team of testers. So CHERR.IO now has a crew of AI agents with their own wallets that use the testnet like real users, and a staff agent that reviews what they submit.

## 2. The crew

| Agent | What it does |
|---|---|
| Treasury | Holds test POL and test USDC and keeps the other wallets topped up. Never uses the website. |
| Staff | Reviews submitted organisations and campaigns (texts and images), approves and publishes them; anything doubtful is held for David. |
| Fundraisers (2) | Register organisations, start campaigns, upload evidence of spending for milestone payouts. |
| Donors (3) | Find campaigns, donate, choose refund or Emergency Pool if a campaign fails, vote on milestone payouts, rate campaigns. |
| Pool | Gives to the Emergency Pool and votes on how it is used. |
| Awkward user | Tries wrong inputs, a phone screen, the back button, double clicks. |
| Dispatcher | Plans each run on the strongest model and hands work to cheaper models; fixed steps use no model at all. |

## 3. Milestones

### 2026-11-24 — The plan and the rules
- Decision: agents run only on the testnet, through a real browser and real wallets, and report every bug with evidence.
- The staff agent may act only on what the crew submitted; real people's organisations and campaigns stay with a human.
- Model split to save credits: dispatcher on Claude Opus, routine work on Claude Haiku, exploring and reviewing on Claude Sonnet, fixed steps on no model.
- Safety built first: the agents' wallet signs only calls to CHERR.IO's own contracts and test USDC; it signs in only to testnet.cherr.io; the key never enters the web page.

### 2026-11-25 — New contracts on the testnet
- The smart contracts from the internal security review were deployed on Polygon Amoy: 11 transactions, all 5 contracts verified, 0.37 POL in gas.
- The first attempt hung for 24 minutes on a gas price that was too low for Amoy; the second went through in a minute. Lesson written into the deploy guide.
- The testnet keeps the real voting rules: a 7-day vote on each payout, 25 % quorum, 51 % approval.

### 2026-11-25 — First agent donation, end to end (run 45607120118)
The donor agent, on its own:
- checked it was running only on the testnet and on Polygon Amoy;
- signed in to testnet.cherr.io with its own wallet through Privy, like any user;
- opened the campaign "Restore the wetland for migrating birds", typed 1 (the goal is in euros, so 1.0963 USDC) and donated through the page;
- confirmed on the blockchain that exactly the amount the page showed was received;
- within 5 minutes confirmed that the indexer and the public API show the same as the chain.

It took seven runs to get there. Each failed run said exactly where it stopped:
1. No live campaign found — the API writes states in lower case.
2. The run ended without output — results are now printed as they happen.
3. The sign-in window had no button for our wallet — the window offers only well-known wallets.
4. The agent's wallet now presents itself as MetaMask inside its own browser.
5. The wallet refused the "may this site see your address" request — now it answers that one, and only that one.
6. Everything worked; only the agent's own check was wrong (it expected exactly 1 USDC, the page converted 1 euro).
7. Green.

### 2026-11-25 — An independent review before the first run
A second AI agent reviewed the code with no access to anything but the diff. It found two serious problems before any run:
- a web page could have asked the wallet for a USDC "Permit" signature, which moves money without a transaction the rules would see — now only the app's own rating message can be signed;
- an iframe or another site could have used the wallet — now only the testnet's own page can.

### 2026-11-25 — Agents are marked, and their content is "Demo"
Every agent wallet is now on a public list in the code. When an agent signs in on the testnet, its account is marked as an agent ("Agent donor-1"), and every organisation or campaign it starts carries the same "Demo" label as our made-up demo data — so it never counts towards the Charity Market Cap, the Trust Score or the points. Two rules were added on the way: an agent can never take over a real charity's profile, and agents never earn points, even when they give to a real campaign.

### 2026-11-25 — One planner, many workers
The crew now runs as a team: the strongest model reads a few numbers about the testnet (how many live campaigns, which agents still have test money) and hands out the day's tasks — donations, giving to the Emergency Pool, checking share links, and an "awkward" user on a phone who types letters into the amount, double-clicks Donate and presses Back. Each task is fixed script; a small model only writes down what confused it on the page ("observations"). Every hard failure becomes a private bug report; the same failure seen again adds a comment instead of a new report.

### 2026-11-25 — The first crew run, and the first thing the agents taught us
Run 45622175784: the planner (the big model) picked three tasks; everything worked except one check — the "awkward" agent expected a "minimum is €1" message for 0, and the site said "Enter an amount". The site was right; the agent's rule was wrong, and was fixed. Run 45624222186 was all green: on a phone, a double click on Donate sent exactly one donation, letters and 0.5 were refused, and Back/Forward worked. A small model wrote three honest remarks a first-time visitor might have — e.g. "Succeeds at 10%" is not explained.

### 2026-11-25 — Test, find, fix: the loop closes the same afternoon
David: "top mi je to, ko testirajo in avtomatsko popravljajo napake" — the part to tell.
- Two crew runs in a row, the small model reading the page as a first-time visitor noted the same thing: right after Back/Forward the donate box said "Donating is not available right now. Please try again later."
- The AI engineer followed it to the cause within minutes: for the few seconds while the sign-in library loads, the box showed the "outage" message instead of "Preparing your wallet…". Every visitor sees that moment on every page view; no human had reported it.
- Fix, a test that fails without the fix (proved by breaking it on purpose), review by CI, merge, deploy — PR #244, the same afternoon. The next crew run checks it again.
- The loop: agents use the testnet like people → hard failures become private bug reports, soft remarks become observations → the AI engineer fixes what is real and corrects the agents when *their* expectation was wrong (run 45622175784: the agent, not the app, was wrong about "0") → the next run re-tests.
- Same day, the planner bug: the dispatcher never sent the pool agent because it skipped agents with less than 2 USDC — but the treasury tops them up only after planning. Found because David asked "the sub-pools exist, why no gifts?"; fixed in PR #243; the next run gave to the Emergency Pool twice.

### 2026-11-25 — The fundraisers start work
Two fundraiser agents now do what a charity does on its first day: register the organisation with its documents and, once verified, start a campaign with a story and a cover picture. The texts are written by a mid-sized model, but treated as data — a text with a link, an e-mail or an account number is thrown away and a fixed text used instead — and every text says plainly that a testnet agent made it. The documents are drawn by the agents' own browser and say "TEST DOCUMENT" across the top. First run (45642806416): fundraiser-1 registered "Lantern Hill Reading Fund", a fictional reading charity the model invented, and it now waits for review — like any real applicant. Next: the staff agent that reviews these submissions.

### 2026-11-25 — The staff agent gets its keys
Before an AI may review anyone's work, it has to get into the admin area the same way a person does: an admin role and a code from an authenticator app every time. There is no back door for the agent. One command on David's laptop signed the staff agent in, set up its authenticator on the real admin page, saved the key where only David can read it, and proved that the key alone opens the door again — about a minute. The agent's every decision will show in the audit log under its own name. Testing it on the real pages first caught two mistakes in the agent's own script before it ever touched the testnet. Next: the reviews themselves.

## 4. Numbers worth quoting
- 9 agent wallets, one treasury.
- 1 test donation per run so far; cost of a run without a model: 0 tokens.
- 28 automated tests guard the agents' wallet rules; each new rule was broken on purpose once to prove its test catches it.

## 5. Post ideas (drafts to write)
0. **"Our AI agents test the testnet — and the bugs they find get fixed the same day."** (David's favourite, 2026-11-25) — the loop above in four steps, with the real example: the "not available" message on Back/Forward, found by an agent's observation, fixed and tested in PR #244 within the hour. Close with the honest part: one of the agents' own checks was wrong too, and was fixed the same way.
1. "We hired a crew of AI agents to use our testnet every day." — what they do, why before mainnet.
2. "Day 1: the first AI donation, end to end." — the five checks above.
3. "Seven runs to one green tick." — the failures as a short thread; each failure taught the product something.
4. "An AI reviewed our AI before it touched a wallet." — the Permit finding, in plain words.
5. "Why our agents can't spend money they shouldn't." — the wallet rules: only our contracts, only the testnet, no key in the browser.
6. "One big model plans, small models work." — credits and the model split.
7. Coming: the staff agent that checks texts and images before a campaign goes live, and holds anything shady for a human.

## 6. To add as it happens
- First run with all personas; first bug an agent found that a human had not.
- First campaign started, reviewed and published only by agents.
- First held submission (the staff agent asking David to look).
- Daily schedule switched on.

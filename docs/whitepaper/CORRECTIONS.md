# Whitepaper corrections log

David (2026-10-04): decisions taken after whitepaper v2.0 are collected here and applied to `whitepaper.md` **at the end of the phase**, in one pass, followed by a rebuild of the PDF (`build.mjs`). Until then the whitepaper text stays as published.

Each entry names the decision, the exact place in `whitepaper.md` and the replacement text. When an entry is applied, mark it **Applied in vX.Y** and keep it for the record.

| # | Decision | Where in `whitepaper.md` | Today | Correct text | Status |
|---|---|---|---|---|---|
| 1 | ADR-045 — vote window 7 days | Chapter 1 key-number box (`::: stats`) | "**24 h** donor vote before each later step is released" | "**7 days** donor vote before each later step is released" | Pending |
| 2 | ADR-045 — vote window 7 days | Chapter 6 "How milestones work", step 3 | "Donors vote for 24 hours." | "Donors vote for 7 days." | Pending |
| 3 | ADR-045 — quorum 25 %, approval unchanged | Chapter 6 "How milestones work", step 4 | "at least 50% of the donated amount takes part" | "at least 25% of the donated amount takes part" (keep "at least 51% of the cast weight approves") | Pending |
| 4 | ADR-045 — no "silence = consent" | Chapter 6 "How milestones work", step 5 | "If turnout is too low, the campaign moves to review and the Guardian decides." | add: "Silence never counts as approval: without enough votes the Guardian decides, on-chain and in public." | Pending |
| 5 | ADR-045 — Emergency Pool votes use the same parameters | Chapter 7 "Money flows out by vote" | "vote for 24 hours … with the same 50% turnout and 51% approval rule as milestones" | "vote for 7 days … with the same 25% turnout and 51% approval rule as milestones" | Pending |
| 6 | ADR-045 — who triggers what | Chapter 6, after the milestone steps (new short paragraph) | — | "Each step is started by the people involved: the fundraiser closes the campaign, submits evidence and counts the votes; donors vote and claim refunds themselves, free of network fees with a CHERR.IO wallet. If nobody acts within 7 days, CHERR.IO's system does it, so no campaign can get stuck." | Pending |
| 7 | ADR-045 — notifications | Chapter 6 (same new paragraph or a note) | — | "Donors get an email when a vote opens and a reminder a day before it closes; wallet-only donors can leave an email for this." | Pending |
| 8 | ADR-049 — conversion rate not final | Points section, Reward bullet | "In Phase 2 it can be converted into CHR at 1,000 points = 1 CHR, with rate limits and a monthly cap" | "In Phase 2 it may be converted into CHR at a rate set for the current supply (85.1 million CHR), with rate limits and a monthly cap" | Pending |

Sources: `docs/03-DECISIONS.md` ADR-045, ADR-049; `docs/tasks/TASK-033-voting-lifecycle.md`; `docs/whitepaper/whitepaper.md` (v2.0).

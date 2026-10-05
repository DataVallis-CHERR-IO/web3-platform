# TASK-039 — Demo data in the production flow (ADR-053)

David, 2026-10-05: demo campaigns must follow the production flow (organisations create their own campaigns; the admin reviews and publishes), with the least effort on dev; options: create by hand in the real form or "Fill with AI" through fal; publish many at once.

Replaces the admin-started demo campaigns of TASK-038a (publishing them hit the four-eyes rule: "You cannot publish a campaign of an organisation you belong to").

## Parts
- **039a — demo organisations.** Migration: `users.is_demo`, `organizations.is_demo`. Pool of made-up organisations (`lib/demo/orgs.ts`). Admin → Demo: "Create demo organisations and campaigns" — new organisations (0–5; 0 = use existing demo organisations), campaigns per organisation (1–5), state `PENDING_REVIEW` or `APPROVED`, payout wallet; max 10 campaigns per batch. Each organisation: synthetic member (ORG_ADMIN), KYB submission APPROVED by the acting admin, payout = the wallet entered. Campaigns from the campaign pool matching the organisation's causes, `starter_user_id` = the member. Repair of the ADR-052 "CHERR.IO Demo" organisation (mark demo, own member, admin membership removed, starter reassigned). No `self_review` exemption anywhere. Covers as in 038b.
- **039b — "Act as" + "Fill with AI".** Dev-only session switch to a demo member and back (audited); "Fill with AI" in the campaign draft form for demo organisations (fal LLM text + Nano Banana cover).
- ~~039c — dev operator key~~ — dropped (David 2026-10-05: publishing is confirmed in MetaMask; "Publish all" from TASK-038c stays).

## Docs
technical 03, 04, 06 (039b), 09; feedback per part.

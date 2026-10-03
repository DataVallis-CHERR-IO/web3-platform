# TASK-029 — UX fixes and admin overview from the first dev test (2026-10-02)

Status: **In progress** — §1 live on dev (PR #34, confirmed by David 2026-10-03); §3 merged and deployed to dev (`TASK-029b.feedback.md`); §2 moved to **TASK-030** (ADR-039, David's decisions 2026-10-03) — David's notes from testing dev on 2026-10-02 (organisation → KYB approval → campaign draft). To be done after TASK-010c; David asked to finish 010 first.
Branches: `fix/…` for small fixes, `feat/TASK-029-…` for the admin overview. Model: standard.

## 1. Bugs and rough edges (small, one fix PR)

| # | Where | Observation (David) | Expected |
|---|---|---|---|
| 1 | "My account" (header → account) | Clicking it shows an error and loads nothing; David had to type `/en/account/campaigns` in the address bar | Find the cause (reproduce with an ORG_ADMIN who has an organisation and a campaign); the account page loads and links to "My organisation" and "My campaigns" |
| 2 | `/en/account/campaigns/new` | The form is very narrow; the fields **Target** and **Duration** overflow on the right | Form uses the normal content width; the two number fields fit at 390 px and 1440 px |
| 3 | Campaign form | A too short story blocked "Save draft", but the error was easy to miss (David thought the button did nothing) | On a failed submit: scroll to and focus the first invalid field, plus a summary alert at the button ("Please fix the 1 field marked above") |
| 4 | Organisation form and campaign form | The country select has no search | Searchable select (type to filter) for country; same component everywhere a long list is chosen |
| 5 | Navigation | A platform admin cannot reach `/en/admin/kyb` (or `/en/admin/campaigns`) without typing the URL | An "Admin" entry in the header/user menu for `PLATFORM_ADMIN` (from the session's DB roles), and links from `/en/admin` to each queue with the number waiting |
| 6 | `/en/admin/kyb/[id]` → Documents | Only extract, proof of representation and statute are listed, although David uploaded the optional documents too | Check whether the "other" documents were attached to the submission (form upload slots → `fileIds` → `private_files.kyb_submission_id`); if they were dropped, fix and add a test; if they were never uploaded, make the form state clear |
| 7 | Publish panel | With MetaMask on the organisation's account, "Publish on Polygon" seemed to do nothing | **Fixed** in `fix/admin-campaigns-approved-list`: every wallet call has a time limit, and a clear message names the wallets that were checked |
| 8 | Logout | After logging out on an admin page the page stayed open | **Fixed** in the same PR: logout on `/account`, `/admin` or `/organizations/new` goes to the home page |
| 9 | Admin campaign queue | An approved campaign disappeared from the queue, so there was no way to the publish button except the URL | **Fixed** in the same PR: second list "Approved — waiting to be published" |
| 10 | Admin campaign list | A published (Live) campaign is on no admin list; it can be opened only by its URL | Covered by the admin overview (§3): all campaigns, filter by status |
| 11 | Dates and times | Admin pages show times in UTC (published 21:43 Ljubljana time is shown as "7:43 PM") | Format dates in the viewer's time zone (`timeZone` from the browser or a user setting; next-intl `getFormatter` with the request's time zone). Rate date stays in UTC (it is a day, not a moment) |

## 2. Campaign media: several images, videos, attachments, PDFs (new feature, David 2026-10-02)

**Moved to `TASK-030-campaign-media.md`** (ADR-039). The questions below are answered there.

David: campaigns must allow uploading several images, videos, attachments and PDFs. Product and storage questions for the CTO spec (ADR needed):
- **Public vs private:**
  - public gallery media (images, short videos) go to the public bucket (ADR-037, metadata stripped);
  - documents such as invoices or medical reports are personal data and go to private storage (ADR-033), visible only to admins/reviewers;
  - what a public PDF may contain needs a rule.
- **Videos:** upload (size limits, transcoding, storage cost) vs a YouTube/Vimeo link.
- **Limits:** number of files, size per type, order and a cover choice; moderation in the review (new media after approval?).
- **Relation to evidence bundles** (TASK-013, hashes on-chain) — keep campaign media separate from payout evidence.

## 3. Admin overview (new feature)

David wants, as a platform admin, to see **all** organisations (also approved ones) and all campaigns, with an overview and statistics, and good UX across the site: **filters, search, pagination (or infinite scroll), fast and smooth**.

Proposal (CTO to turn into a spec):
- `/en/admin/organizations`: table of all organisations, with:
  - search by name or registry number;
  - filters by KYB status, country and source (registered/imported);
  - server-side pagination (keyset, 50 per page);
  - columns: name, country, status, number of campaigns, created.
  - Detail: data, members, KYB history, campaigns.
- `/en/admin/campaigns`: the same for all campaigns:
  - search by title or organisation;
  - filters by status, cause and country;
  - columns: target, status, created/submitted.
  - The current queue becomes the "Waiting for review" filter.
- `/en/admin`: small stat tiles:
  - organisations by KYB status;
  - campaigns by status;
  - applications and campaigns waiting, with the oldest waiting time.
- Speed: indexed queries (`kyb_status`, `status`, `created_at`, trigram or `ILIKE` on names as decided), no client-side filtering of full lists, URL-based filter state (shareable, back button works).
- Applies the same table/filter/pagination component to later public lists (campaigns, Charity Market Cap).

## Answered in the chat (no work)
- KYB approval is stored in the database only, not on-chain (ADR-012): documents are personal data. The organisation's verified payout address goes on-chain as the campaign's beneficiary when a campaign is published (TASK-010c). David agreed.
- The public media bucket works: a cover uploaded on dev opens in a private window (2026-10-02).

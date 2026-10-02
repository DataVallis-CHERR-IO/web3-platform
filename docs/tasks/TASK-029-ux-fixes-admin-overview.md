# TASK-029 — UX fixes and admin overview from the first dev test (2026-10-02)

Status: **Backlog** — David's notes from testing dev on 2026-10-02 (organisation → KYB approval → campaign draft). To be done after TASK-010c; David asked to finish 010 first.
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

## 2. Admin overview (new feature)

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

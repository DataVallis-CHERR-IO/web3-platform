# TASK-021 — Admin menu + audit log view

Status: Live on dev (PR #198, Deploy 37973269064); confirmed on dev by David 2026-10-09. Decision: David 2026-10-09 ("ja, uredi") on the CTO proposal from `HANDOFF.md` → Next.
Depends on: TASK-029 (admin lists), TASK-049 (admin second factor, ADR-056 — the "Privy MFA step-up" once planned here is done there).

## Why
The admin area grew page by page (KYB, campaigns, organisations, chain actions, Emergency Pool, contracts, demo). Each page was reached through a button row on `/en/admin` or "Back" links, and `app.audit_log` — written by every admin decision, chain action, file download and MFA event — could only be read on the server. Investors and the prod launch need a simple answer to "who did what and when".

## Scope
1. **One admin menu** on every admin page (`AdminNav` in `app/[locale]/admin/layout.tsx`, after the role + second-factor gate): Overview, Organisation applications, Campaigns, Organisations, Chain actions, Emergency Pool, Contracts, Audit log, Demo campaigns (local/dev only). A tab row on top at every width (wide admin tables keep the full width); `aria-current` on the current page. Remove the button row on `/en/admin` and the "Back to the admin overview" links.
2. **Admin → Audit log** (`/en/admin/audit`): read-only, newest first, 50 per page, keyset pagination on `(created_at, id)`; columns time, who (name or "System"), action, subject (type + short id, link to the admin page of campaigns / organisations / KYB applications, "history" = this record only), details (`data` as JSON). Filters in the URL: part of the action, subject type (types in use), who (anyone / system / one person via a click), one record. **IP is never shown.**
3. "Audit log of this record" link on the admin campaign, organisation and KYB application pages.
4. Migration: index `audit_log (created_at, id)` (`0023`).
5. Tests: Vitest on Postgres (pages with identical timestamps, every filter, URL parsing, links), E2E (menu, search, person, record, back, axe), admin pages in `admin-hidden.spec.ts`; existing E2E moved from the removed buttons to the menu.
6. Docs: technical 01, 03, 04, 06, 09, CHEATSHEET, owner guide v1.9 (menu name "Emergency Pool", audit log in §10).

## Not in scope (on purpose — small change that pays off)
CSV export, date-range filter, seconds in the time column, auditing who viewed the audit log, editing or deleting entries (the app has no such path), showing IPs.

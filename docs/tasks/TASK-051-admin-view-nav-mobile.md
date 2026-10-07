# TASK-051 — Admin list view tabs on phones

Status: Live on dev (PR #142, Deploy 37626609579) · Owner decision: none needed (layout fix from the pre-MVP list, HANDOFF "Next 4", David's go-ahead 2026-10-07: "uredi")

## Problem
At 390 px the view tabs of **Admin → Campaigns** (6 views) and **Admin → Organisations** (5 statuses) wrap into uneven lines: the current view is a large filled button, the others are underlined links of different widths, and "Approved — waiting to be published" breaks over two lines with its count hanging at the right.

## Scope
- A shared class `.ch-view-nav` in `packages/ui/src/styles/components.css`:
  - desktop: unchanged (one row of buttons, 8 px gap);
  - ≤ 640 px: a framed list (3 px ink border), one view per row, min 48 px tall, label left and count right, rows separated by 2 px lines, the current view filled with the accent and underlined.
- Use it on `admin/campaigns/page.tsx` and `admin/organizations/page.tsx`.
- Guard: `e2e/admin-view-nav.spec.ts` — 390: every tab is full width inside the frame and below the previous one; 1440: all tabs on one line.

## Out of scope
- Horizontal scrolling tabs or a select menu (hidden views are easy to miss; six rows fit on one phone screen).
- Other admin pages (they have no view tabs).

# TASK-041 — Filter panel layout and page container

Source: David on dev, 2026-10-05 09:14, after merging TASK-039: "malo lepše bi pa lahko grafično naredil te filtre, ne da je kr nametano... pa admin nima nič paddinga ob straneh, vsebina je od roba do roba". Ad-hoc task.

## Scope
- `/campaigns` filters as one framed panel: a label column and a control column per row, chips with the count in its own cell, the active chip filled with ink, a result bar at the bottom ("N campaigns" + "Clear filters"); the country select with a chevron cell like the admin selects; on phones one sideways-scrolling row of chips.
- Define `.ch-container` (used by 21 account/admin/form pages, defined nowhere): centred, max 1440px, side gutters 64px / 24px at ≤ 1024px — the same as the public pages.
- Guard test: every `ch-*` class used in a component must exist in `components.css` / `theme.css`.

## Not in scope
Other admin layout changes (tabs wrapping on phones, tables).

## Tests
Vitest guard with a deliberate break (remove `.ch-container`); TASK-039 E2E still passes with the new markup (chip names via `aria-label`); full E2E; screenshots at 1440 and 390.

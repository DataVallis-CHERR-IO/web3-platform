# TASK-042 — Shop-style filters on the campaign list

Source: David, 2026-10-05 09:39: "ti tabi za cause filter mi niso všeč, kaj če bo 200 različnih causev? … Daj naredi po vzoru spletnih trgovin … filtri se odprejo, npr v sidebar … na mobile pa se gor pripeljejo kot nov modal … naj bo dober UX". Replaces the TASK-041 chip panel.

## Scope
- Multi-select: `?cause=` and `?country=` repeatable (and comma lists); OR within a group, AND across groups; unknown values ignored; facets count each group within the other group's choice.
- Wide screens: sticky sidebar "Filters" with collapsible checkbox groups (count per option, sorted by count), first 6 + chosen ones visible, "Show all N" / "Show fewer", search box above 8 options (accent-insensitive). Ticks apply at once (optimistic local state + `router.replace`, no scroll); a real GET form with "Apply" without JavaScript.
- Above the results: count, active filters as removable tags, "Clear all".
- ≤ 1024px: "Filters (n)" button → bottom sheet (Radix dialog, focus trapped) with the same groups, "Clear all" and "Show N campaigns".

## Not in scope
Sorting, text search over titles, saving filters.

## Tests
Unit tests for the list logic (sort, collapse, chosen kept visible, search, toggle, query), DB tests for multi-select and facets, stub test for the fallback query, E2E on both viewports (sidebar / sheet, axe on the open sheet), deliberate break.

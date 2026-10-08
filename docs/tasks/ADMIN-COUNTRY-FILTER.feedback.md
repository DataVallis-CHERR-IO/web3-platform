# Admin country filter — feedback
Status: DONE — Live on dev (PR #172)
Prompt: David 2026-10-08 — "na strani organizations ko mam country filter, manjka search v dropdownu in … v filter samo države od katerih imamo organizacije".

## What I implemented
- `countriesInUse(db, "organizations" | "campaigns", locale)` (`lib/admin/listing.ts`): distinct countries of the table with counts, sorted by name; used by `/en/admin/organizations` and `/en/admin/campaigns` (options and the allowed `?country=` values).
- `SearchableSelect`: the field's text is selected on focus and click. The list already filtered by typing, but the typed letters were appended to "Any country", so nothing matched — it looked as if there were no search.

## Test results
New E2E `admin-country-filter.spec.ts` (1440 + 390): an organisation in Vanuatu → option "Vanuatu (n)", no "Antarctica", typing "vanu" leaves one option, Enter filters the list (`?country=VU`). With `kyb-review`, `organization`, `campaigns`: `18 passed (1.4m)`.
Deliberate break — select-on-click removed:
```
    Error: expect(locator).toHaveCount(expected) failed
    Expected: 1
    Received: 0
  1 failed
```
restored → `2 passed (13.6s)`. Typecheck, lint, `check:design`: clean.

Also recorded: US import = only 501(c)(3) (David); Slovenia source still open (TASK-016 spec).

## Suggested commit message
feat(admin): country filter lists only countries in use, and typing filters at once

# TASK-044 — Sanctioned countries + Terms of Service and Privacy Policy (ADR-054)

Decision: David, 2026-10-05 ("yes, se strinjam"), after the Stripe onramp application asked for an attestation about high-risk countries and for published terms.

## Scope
1. `packages/shared/src/organizations.ts`: `SANCTIONED_COUNTRY_CODES` (BY, CU, IR, KP, RU, SY), `isSanctionedCountry`, `ALLOWED_COUNTRY_CODES`; organisation and campaign schemas accept only allowed codes.
2. Forms: organisation application and campaign form list allowed countries only.
3. Server: KYB approval and campaign approval refuse `sanctioned_country` (409), also for records stored before this change.
4. Admin: a warning on the KYB, organisation and campaign pages when a record carries a sanctioned country.
5. `/en/terms` and `/en/privacy`: draft 0.1, marked as under legal review, footer links.
6. Tests: shared validation, KYB and campaign approval (Postgres), E2E for both legal pages (axe).

## Not in scope
- IP geo-blocking of "Add money" (no IP-to-country source; the onramp partner screens). Planned if required.
- Region-level blocking (Crimea etc.): manual review.
- Legal review of the texts (David, with a lawyer).

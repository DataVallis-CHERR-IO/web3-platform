# TASK-050 — Terms and Privacy links at sign-in

Status: Live on dev once merged (see feedback)
Depends on: TASK-025 (auth), TASK-044 (Terms/Privacy pages, ADR-054)
Decision: David 2026-10-05 — "terms-acceptance line at sign-up = yes".

## Goal
Whoever signs in sees that continuing means accepting the Terms of Service and the Privacy Policy, with links to both pages. Needed for the Stripe onramp application and before the public testnet MVP.

## Scope
- Privy's sign-in window gets the Terms and Privacy links through the `legal` setting of `PrivyProvider` (`termsAndConditionsUrl`, `privacyPolicyUrl`). Privy prints its own footer line in the window ("By logging in I agree to the Terms and Privacy Policy" — Privy's text).
- The links are absolute and point to the current environment and page locale: `<origin>/<locale>/terms`, `<origin>/<locale>/privacy`. Setting them in code overrides the Privy dashboard, so dev/uat/prod each link to their own pages.
- Test that the provider passes the links (E2E has no Privy app).

## Out of scope (on purpose)
- Recording which `LEGAL_VERSION` a user accepted (column + audit). Only if the legal review asks for proof of acceptance.
- Own line under the header "Log in" button — the sign-in window is where the user actually signs in; a second line would repeat it.

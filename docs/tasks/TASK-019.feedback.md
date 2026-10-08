# TASK-019 feedback — embeddable donate widget
Status: DONE (Built; PR pending) — David 2026-10-08: "nadaljuj z … gumb za doniranje, ki ga drugi vgradijo na svojo stran".

## What I implemented
- **Code for other sites:** `<script src="https://app.cherr.io/widget.js" async></script>` + `<cherrio-donate campaign="<slug>" theme="light|dark|auto"></cherrio-donate>`. `/widget.js` (`lib/embed/widget.ts` `widgetJs`) defines the custom element; it builds an iframe only for well-formed slugs and accepts height messages only from our origin and its own frame.
- **Widget page** `/embed/campaigns/<slug>` (plain HTML route, no app bundle, no cookies): organisation (+ Verified), title, progress bar (% of the goal), "% of €goal · donors · days left", **Donate** opening the campaign on CHERR.IO in a new tab (`?utm_source=widget`), "See the campaign" once it ended; design tokens from `/embed/tokens.css` (a copy of `packages/ui/src/styles/tokens.css`, a test fails when they differ); light/dark/auto. Headers: `frame-ancestors *`, `default-src 'none'`, no forms.
- **Why not donate inside the iframe:** sign-in, wallets and card payments must not run inside someone else's page (third-party cookies, clickjacking); the widget sends the donor to the campaign page.
- **Clickjacking protection for the rest of the app:** the middleware now sends `Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN` on every page and API response — before, any site could frame the app.
- Campaign page: "Put this campaign on your website" (`components/campaigns/EmbedCode.tsx`) with the code and "Copy code".

## Test results
- `src/__tests__/embed-widget.test.ts` (4: escaping + bar cap, ended campaign, script guards + snippet, token copy equals the design system): `Tests 4 passed (4)`.
- E2E `e2e/donate-widget.spec.ts` (partner page on another origin from a small local server → widget iframe shows the escaped title, organisation, 25 % of €15,000, Donate with `target=_blank`; `/embed` may be framed, `/en` sends `X-Frame-Options: SAMEORIGIN`; the campaign page offers the code), both viewports: `4 passed`. Earlier attempts failed on Chrome's rules, not on the widget: an `about:blank` host is not a "network scheme" for `frame-ancestors *`, and a Playwright-fulfilled host is an "unknown" address space for private-network access — hence the real local server.
- Screenshots of the widget (1440) and the code box checked.

## Not done
- Donating inside the widget (see above); an image-only badge for e-mails; per-site analytics beyond `utm_source=widget`.

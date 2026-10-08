# TASK-059 feedback — static campaign link preview
Status: DONE — Live on dev (PR #168 merged 2026-10-08, all checks green; Deploy run 37751775503 green)
Prompt: David 2026-10-08 — the X preview showed an old cherry picture; make the preview "bolj opasno" with the CHERR.IO logo. After three rounds of proposals (A dark panel → A2 percent → static "S2"): static image, goal track with the 10 % line instead of a fake progress bar ("ok zdaj mi je kul ja, uredi"); preview bots may read dev; amounts not in USDC, US expansion → goal currency recorded as a proposal.

## What I implemented
- **Cause of the old picture:** dev's robots.txt blocked every crawler, Twitterbot included, so X never saw our page. `robotsBody()` now allows link-preview bots (Twitterbot, facebookexternalhit, Facebot, LinkedInBot, WhatsApp, TelegramBot, Slackbot-LinkExpanding, Discordbot) on non-prod; `User-agent: *` and the AI crawlers stay `Disallow: /`, pages still send `X-Robots-Tag: noindex`.
- **New `CampaignOgImage`** (design S2): cover; dark panel with the real wordmark SVG, cause · country, organisation (+ "verified organisation"), title, "Goal €10,000" and "Until 18 Oct 2026", empty goal track with the 10 % success line and its sentence, "Every donation public on Polygon", Donate. Variants `live` / `funded` ("Funded · thank you") / `ended` ("Campaign ended") by `ogVariant(publicState)`. Site preview: same dark panel, real wordmark.
- **Stored once per content:** `lib/og/store.ts` — key `og/<campaign id>/<sha256 of what is shown + design version>.png` in the public bucket; read first, else render and store (not when the cover failed to load). `cache-control` 3600 s.
- Goal currency: formatted as "the campaign's goal currency" (EUR today); ADR proposal for USD goals in `docs/technical/09` §4.

## Deviations
- The image shows the date as the deadline in UTC ("Until Oct 18, 2026" in `en`).
- A campaign past its deadline but not yet finalized still shows the `live` variant (Donate) until the chain state changes.
- Old stored previews are not deleted when the content changes (small orphans under `og/`); a sweep can come later if they add up.

## Test results
`og-image.test.ts` (variant mapping added; route test now checks one stored object, a second request served from the bucket with identical bytes, a new title → a new object): `Tests 6 passed (6)`. Robots test updated (preview bots allowed, nothing that indexes allowed): `admin-hidden.test.ts` `Tests 9 passed (9)`.
Deliberate break — store key without the content (variant only):
```
   × preview image routes > render a published campaign (with a Slovenian title) and fall back for an unknown one 1047ms
     → expected true to be false // Object.is equality
      Tests  1 failed | 5 passed (6)
```
restored → `Tests 6 passed (6)`.
Full web suite: `Test Files 64 passed (64)`, `Tests 546 passed (546)`. Typecheck, lint: no errors; `check:design` passed.
E2E `campaign-share.spec.ts` (og:image absolute, 1200×630 PNG, new cache header) + `a11y.spec.ts`, local production build: `74 passed (2.3m)`.
Render cost measured locally: ~200 ms per image (cover resize ~20 ms; first render after start ~550 ms) — now paid once per content. Route render checked by eye (Slovenian title with č/š, no-cover fallback).

## Open questions / risks
- Networks keep their own copy: a link shared before this deploy keeps the old picture until the network refreshes it (X ~7 days; Facebook via its Sharing Debugger).

## Suggested commit message
feat(web): static campaign link preview, stored once; preview bots on dev (TASK-059)

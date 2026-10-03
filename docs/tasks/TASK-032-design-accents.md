# TASK-032 — Design accents and scanability (design system v1.1)

> Numbering: written by the CTO as "TASK-029" with "ADR-039". In the repository TASK-029 (UX fixes + admin overview), ADR-039 (campaign media) and ADR-040 (display currency) already existed, so this task is **TASK-032** and its decision **ADR-041**. Content unchanged.

Branch: `feat/TASK-032-design-accents` from `dev`. One PR. Model: standard.
Depends on: TASK-007 (design system in code). Approved by David 2026-10-03 from a before/after preview (CSS overlay on the real landing page and `/dev/ui`).

## Why

User feedback: "too black / white / grey; hard to scan while scrolling; the base is good, add some colour accents." The palette stays the brand palette (Pantone 192–195 cherry, 427–433 greys, `Cherrio_Colors.pdf`). What changes is **how much cherry is used for wayfinding**, **section rhythm**, **status colours** and **heading hierarchy**. Everything goes through tokens and `packages/ui` / shared CSS so pages update without page rewrites.

## Decision — add to `docs/03-DECISIONS.md` (after the last ADR)

| ID | Date | Status | Decision | Reason |
|---|---|---|---|---|
| ADR-039 | 2026-10-03 | Accepted | **Design system v1.1: cherry for wayfinding, tinted section bands, functional status colours.** Amends ADR-022's "one loud cherry block per view": a view still has at most one solid cherry *action* per section, but cherry is also used for wayfinding (eyebrows with a cherry dash, active nav, key figures, links, heading underline bar). New tokens: `cherry-50` (tint band) and `cherry-100`; functional **status** colours `success-700/50` (green) and `warning-700/50` (amber), used **only** in status chips, notices and verified marks — never for actions, text blocks or decoration. Photos carry their own colour. | Feedback that the UI is hard to scan; the brand palette is kept, only its use is widened. |

## Tokens (`packages/ui/design-system/tokens.json` → `tokens.css`, both themes)

| Token | Light | Dark | Use |
|---|---|---|---|
| `cherry-50` | `#fff0f4` | `#2a0812` | tint band behind a section |
| `cherry-100` | `#ffd9e4` | `#4a0f22` | tint borders / hover on tint |
| `success-700` | `#0b6b33` | `#4cc77f` | VERIFIED / SUCCEEDED / APPROVED chip fill (light) or text (dark) |
| `success-50` | `#e2f4e9` | `#0e2a1a` | success notice background |
| `warning-700` | `#7a4f00` | `#f2b84b` | VOTING / PENDING_REVIEW text + border |
| `warning-50` | `#fff1cc` | `#2e2208` | warning chip / notice background |

Contrast must pass WCAG AA (≥ 4.5:1 for text): check every new pair with a script in the test suite (white on `success-700`, `warning-700` on `warning-50`, `cherry-700` on `cherry-50`, dark-theme pairs).

## Component and CSS changes

1. **Header:** 6px `cherry-500` top border; active nav item `cherry-700` with a 3px cherry underline (use the current route, `aria-current="page"`).
2. **Eyebrow / tagline** (`.ch-landing-tagline`, step labels, and a new reusable `Eyebrow` style): `cherry-700` text with a 22×6px cherry dash before it.
3. **Section heading** (new `SectionHeading` component or class): `--font-display`, 44px desktop / 30px mobile, an 72×8px cherry bar under it. Use on landing sections and on app page titles (account, admin, campaigns).
4. **Key figures:** the raised amount in `ch-progress-figures` and Trust Score numbers in `cherry-700`.
5. **Links / ProofLink:** `cherry-700` text, cherry underline.
6. **Section bands:** a `Band` wrapper (or `.ch-band-tint`, `.ch-band-raised`) that paints a full-bleed background (`cherry-50` or `white`) with the content kept in the container. Landing: steps → tint, Charity Market Cap → white (with 3px ink rules top and bottom), Emergency Pool → dark block with a 12px cherry left border.
7. **StatusChip variants:** LIVE stays cherry; VERIFIED / SUCCEEDED / APPROVED → `success-700` fill, white text; VOTING / PENDING_REVIEW → `warning-50` fill, `warning-700` text + border; IMPORTED / DRAFT → outline `slate-500`; REJECTED / FAILED stay `cherry-900`. Glyphs stay (never colour alone).
8. **Verified mark** (`.ch-verified`): `success-700`.
9. **Featured CampaignCard:** hard shadow in `cherry-500` instead of ink.
10. Dark theme: equivalent mapping; check `/dev/ui` in both themes.

The approved preview CSS is the reference for values and look: see "Reference CSS" below.

## Copy changes (`apps/web/messages/en.json`)

- `landing.hero.tagline`: `TRANSPARENT GIVING FROM MARIBOR, SLOVENIA` → **`GIVING YOU CAN VERIFY`**
- Hero photo placeholder text: remove "UKC Maribor" (→ "outside the hospital").
- Footer `operatedBy`: `Operated by Data Vallis d.o.o., Maribor, Slovenia` → **`Operated by Data Vallis d.o.o.`** (the full company address stays on the About page — legal imprint).
- Keep: About page company address, country placeholders and Slovenian registry names (functional).
- Headline already reads `EVERY CENT, ON THE RECORD.` — keep.

## Landing rules (write into `packages/ui/design-system/README.md` → "Landing & marketing pages")

1. Every section starts with an eyebrow (cherry dash + cherry text) and a section heading with the cherry bar.
2. Section backgrounds alternate: ground (mist) → tint (cherry-50) → raised (white) → dark; never two equal bands in a row.
3. At most one solid cherry button per section.
4. The key number of a section (amount, score, count) is `cherry-700`.
5. Colour comes from photos; UI colour is cherry + greys; green/amber only for status.
6. Mobile: same bands, heading 30px, eyebrow dash stays.

## Tests / proof

- Contrast test for all new token pairs (both themes) — must be able to fail (break one value once, show it).
- E2E axe on landing, `/dev/ui`, account and admin pages: no violations (light; dark if the suite supports it).
- `check:design` passes (no colours outside tokens).
- Screenshots in the feedback: landing and `/dev/ui`, before/after (Playwright, local).
- No local docker build (CI image build).

## Docs

ADR-039; `packages/ui/design-system/README.md` (tokens, chip mapping, landing rules); technical 04 (design system v1.1); 09. David updates the external design-system artifact from the README.

## Reference CSS (approved preview overlay)

```css
:root { --cherry-50:#fff0f4; --cherry-100:#ffd9e4; --success-700:#0b6b33; --success-50:#e2f4e9; --warning-700:#7a4f00; --warning-50:#fff1cc; }
.ch-header { border-top: 6px solid var(--cherry-500); }
.ch-header-link[aria-current="page"] { color: var(--cherry-700); text-decoration-color: var(--cherry-500); text-decoration-thickness: 3px; }
.ch-landing-tagline, .ch-landing-step-label { color: var(--cherry-700); display: inline-flex; align-items: center; gap: 10px; }
.ch-landing-tagline::before, .ch-landing-step-label::before { content: ""; width: 22px; height: 6px; background: var(--cherry-500); }
.ch-progress-figures > :first-child, .ch-landing-cmc-score { color: var(--cherry-700); }
.ch-landing-cmc-link, .ch-proof { color: var(--cherry-700); text-decoration-color: var(--cherry-500); }
.ch-landing-campaigns-heading, .ch-landing-cmc-heading { font-family: var(--font-display); font-size: 44px; line-height: 1.05; }
.ch-landing-campaigns-heading::after, .ch-landing-cmc-heading::after { content: ""; display: block; width: 72px; height: 8px; background: var(--cherry-500); margin-top: 14px; }
.band-tint { background: var(--cherry-50); box-shadow: 0 0 0 100vmax var(--cherry-50); clip-path: inset(0 -100vmax); padding-block: 56px; }
.band-raised { background: var(--white); box-shadow: 0 0 0 100vmax var(--white); clip-path: inset(0 -100vmax); padding-block: 64px; border-block: 3px solid var(--ink); }
.ch-landing-ep { border-left: 12px solid var(--cherry-500); }
.ch-chip-solid, .ch-verified { background: var(--success-700); border-color: var(--success-700); color: #fff; }
.ch-chip-voting { background: var(--warning-50); border-color: var(--warning-700); color: var(--warning-700); }
.ch-chip-outline { border-color: var(--slate-500); color: var(--slate-500); }
.ch-card-featured { box-shadow: 6px 6px 0 0 var(--cherry-500); }
```

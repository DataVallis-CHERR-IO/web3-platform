# CHERR.IO whitepaper

The designed PDF is built from the sources in this folder. To change the whitepaper, edit the sources and rebuild; never edit the PDF.

| File | What it is |
|---|---|
| `whitepaper.md` | **The text.** Front matter (title, headline, version, date, file name) + one `## N. Title` per chapter. |
| `template/style.css` | Layout and print design (A4, Paged.js). Colours and type follow `packages/ui/design-system` (ADR-022). |
| `template/whitepaper.html` | Cover, contents page and back cover. Placeholders like `{{version}}` come from the front matter. |
| `diagrams/*.svg` | Diagrams, inlined into the PDF so they use the document fonts. Edit them as plain SVG. |
| `assets/` | Logos copied from `packages/ui/design-system/assets/files`. |
| `build.mjs` | The build: Markdown → HTML → PDF in headless Chromium. |
| `dist/CHERR.IO-Whitepaper-v<version>.pdf` | The built PDF (committed, so it can be downloaded from GitHub). |

The content is derived from `docs/01-PRODUCT-SPEC.md` and `docs/03-DECISIONS.md`. If they change, update `whitepaper.md`; the ADRs win.

## Build

This folder is **not** part of the pnpm workspace; it has its own `package.json`.

```bash
cd docs/whitepaper
npm install                 # once
npm run build               # -> dist/CHERR.IO-Whitepaper-v2.0.pdf
npm run html                # -> build/whitepaper.html only, open it in Chrome to preview
```

Chromium: the build uses `CHROMIUM_PATH` if set, then `/opt/pw-browsers` (Claude cloud sessions), then the Playwright browser cache. On a laptop without it, run `npx playwright-core install chromium` once, or point `CHROMIUM_PATH` at Google Chrome (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` on macOS).

## Writing guide

- **New chapter:** add `## 19. Title`. It starts on a new page and appears in the contents with its page number automatically.
- **Full cherry page:** add `{.feature}` after the heading, e.g. `## 2. Why "Cherry"? {.feature}`. Use it sparingly.
- **Sub-heading:** `### Title` (uppercase with a rule above).
- **Callout box:**
  ```
  ::: note Legal gate
  Text of the note.
  :::
  ```
- **Key numbers band** (up to 4 boxes; the bold part is the big number):
  ```
  ::: stats
  - **10%** of the target raised makes a campaign successful
  :::
  ```
- **Diagram:** `![Accessible description](diagrams/name.svg)`. Use the existing SVGs as a style reference: 3px ink (#090c0d) borders, a 4px offset ink shadow, cherry (#ff0052) only for the one thing that matters, Archivo font.
- **Quote:** `> text` renders as a dark quote block.
- **New version:** change `version`, `date` and `filename` in the front matter, rebuild, commit the new PDF and delete the old one.

After every build, open the PDF and check new tables and diagrams for overflow before committing.

# Design references

- **Design system** (source of truth): CHERR.IO Design System artifact — exported to `packages/ui/design-system/`.
- **Key screens** (visual spec): CHERR.IO Key Screens canvas — exported here as `mockups/*.dc.html`:
  - `Main.dc.html` — landing page (human layer)
  - `Campaign.dc.html` — campaign detail: donate panel, protection steps, updates, `#proof` section
  - `MarketCap.dc.html` — Charity Market Cap listing with Trust Score
  - `CampaignMobile.dc.html` — donor vote on receipts, 390px mobile

The mockups are HTML with inline styles. `<x-import component-from-global-scope="Cherrio.X" …>` means "render component X from packages/ui with these props". `{{…}}` values come from the `renderVals()` script at the bottom of each file. Photos are labelled placeholders.

`<img src="/_blob/…">` in the mockups are the logos: use `packages/ui/design-system/assets/files/cherrio-wordmark-cherry.svg` (header) and `cherrio-wordmark-white.svg` (footer).

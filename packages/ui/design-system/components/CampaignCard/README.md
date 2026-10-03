# CampaignCard

**Human layer.** The listing card: **full-colour photo**, the beneficiary's name, a sentence-case title, EUR progress. Square and bordered; the **one** featured card per grid gets `featured` (hard shadow).

- Photo is required for live campaigns (real people, real place; no stock). Without one the media shows the hatch.
- No addresses, hashes or token names on cards.

Consumer provides: `title`, `org`, `verified`, `image`, `imageAlt`, `status`, `raised`, `target`, `donors`, `daysLeft`, `featured`.

**`statusLabel` is plain translated text** (`string`), e.g. `t("ui.status.live")`. The card wraps it in its own `StatusChip`; passing a `<StatusChip>` element rendered a chip inside a chip (the stray cherry box on `/en/dev/ui`, fixed 2026-10-03). The prop type is `string` so this cannot compile again; `apps/web/src/__tests__/campaign-card-chip.test.tsx` checks that exactly one chip renders.

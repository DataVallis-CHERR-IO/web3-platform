CHERR.IO has two layers. The **human layer** is what every donor sees: real people, real photos, euros and plain words. The **proof layer** sits one click deeper: the public ledger with addresses, hashes, USDC and vote maths. Both use the same brutal structure (square boxes, 3px ink borders, hard offset shadows, cherry as the only UI colour), so the proof feels built in rather than bolted on. Most donors never open the proof layer. Knowing it is there is what earns their trust.

## The two layers

| | Human layer (default) | Proof layer (`#proof` section, ledger pages) |
|---|---|---|
| Audience | Donors, charities, first-time visitors | Sceptics, journalists, crypto users, auditors |
| Money | **EUR**, no decimals: `€12,480` | **USDC**, 2 decimals, `mono`: `12,480.00 USDC` |
| Type | `sans` (Archivo), sentence case | `mono` (IBM Plex Mono) |
| Chain data | Never shown. Use `ProofLink` ("Verified on blockchain ↓") | `LedgerTable`, `Address`, tx links ↗, block numbers |
| Components | Button, Field, Progress, CampaignCard, MilestoneTrack, VoteMeter, TrustScore summary, StatusChip | LedgerTable, Address, TrustScore breakdown, StatusChip |
| Photos | Full colour, real people and places | None |

**Rule:** every claim in the human layer ("€12,480 raised", "Step 1 paid out", "Receipts approved") has a `ProofLink` next to it that leads to the evidence.

## Content fundamentals

- **Voice: warm, plain and exact.** Speak like a trusted friend who keeps the books. Write "Susan needs surgery by December. Every cent goes into a locked account and is released only when donors approve the hospital's receipts." Hype like "Revolutionizing giving on-chain!" is off-voice.
- **No Web3 words in the human layer.** Use these instead:
  - wallet → "account" (card donors) or "crypto wallet" (option label only)
  - USDC → euros
  - tranche → step
  - smart contract / escrow → "locked account"
  - gas → never mention (it's sponsored)
  - on-chain → "on the blockchain", used only in `ProofLink`
  - quorum / turnout → "enough donors voted"
  - token → only on CHR pages (Phase 2)
- **Say who, not what.** Write "Children's Health Maribor", not "the beneficiary". Donors are "donors", registered users "Cherrions" (community pages only), and campaign owners are named people or organisations.
- **Casing:** the hero line (`display-1`), chips, labels and table headers are UPPERCASE. Everything else is sentence case. The brand is always written `CHERR.IO`.
- **Numbers:** amounts in the human layer are euros with no decimals. Show the exact USDC value only in the proof layer and in the donation confirmation's "Details". Never round in the proof layer.
- **Errors say how to fix the problem:** "The minimum donation is €1." No apologies, and never "Something went wrong."
- **No emoji.** Status glyphs are typographic only: ● ◐ ✓ ○ ! ‖ ✕ ↗ ↓.
- **English at launch, all through next-intl.** Leave room for text about 30% longer, such as German.

## Visual foundations

### Colour
- **Grounds:**
  - Light: page on `surface`, cards and inputs on `surface-raised`, wells and table headers on `surface-sunken`.
  - Dark mirrors this (`slate-900` / `slate-700`).
- **Text and borders:** text is `ink`, secondary text `ink-muted`. Borders are `line` at `border-bold`.
- **Cherry is the brand colour of the UI** (v1.1, ADR-041):
  - `accent` for the primary action, the progress fill and the Raising chip, with **at most one solid cherry action per section**.
  - Cherry is also used for **wayfinding**: eyebrows (cherry dash + cherry text), the active nav item, the key figure of a section, links and the bar under section headings. Wayfinding text uses `wayfinding-text` (cherry-700 on light, the light cherry tint on dark — it passes on raised surfaces too); other cherry text uses `accent-text`.
  - Text on cherry is ink (`on-accent`). White appears only on `accent-hover`, cherry-700 and `danger`.
- **Photos are the warmth.** Campaign photos appear in full colour and large: the detail-page hero is 8 columns wide, cards are 16:9. They show real people and places, never stock images.
- **Functional status colours (v1.1), status only:** `success-700` / `success-50` (green) and `warning-700` / `warning-50` (amber) appear **only** in status chips, notices and the verified mark — never for actions, text blocks or decoration. State is still fill style + glyph + word (`StatusChip`), never colour alone. No blue.
- **Section bands (v1.1):** `cherry-50` (tint) and `cherry-100` (borders/hover on a tint), plus raised (`surface-raised` with 3px ink rules) and dark blocks, give long pages a rhythm. Classes: `.ch-band-tint`, `.ch-band-raised` (full-bleed background, content stays in place).
- **No gradients** in the UI.

### Type
- **Hero line:** `display-1` (Archivo Black, UPPERCASE, ≤5 words), once per page.
- **Titles:** `display-2` / `heading-1` (Archivo Black), sentence case.
- **UI and reading:** `heading-2`, `heading-3`, `body-lg` (stories, max 65ch), `body`, `body-sm`, and `label` (UPPERCASE).
- **`mono` is for the proof layer**, plus the digits inside amount inputs. Human-layer amounts use `sans` at weight 800 with tabular numerals.

### Shape, borders, shadows
- **Everything is square** (`radius-none`). `radius-dot` only for dots.
- **Borders:**
  - `border-bold` (3px, `line`) for cards, inputs, buttons, photos and tables.
  - `border-rule` (2px) for section rules and the success tick.
  - `border-hair` (1px, `line-soft`) only between ledger rows.
- **Shadows:**
  - `shadow-hard` on primary buttons and the one featured card per view.
  - `shadow-hard-sm` on secondary buttons.
  - Everything else is flat. In dark mode the hard shadow turns cherry.
- **Hatch (45° stripes)** means "being reviewed": donors reviewing a step, team reviewing, paused. Don't use it as decoration.

### Layout
- **Grid:** 12 columns, 4px base, minimum gutter `space-4`. `space-6` between cards, `space-12` between sections.
- **Campaign page:**
  1. Colour photo and story (8 columns), with a sticky donate panel (4 columns): Progress, Field in EUR, primary Button, then `ProofLink`.
  2. "How your money is protected": MilestoneTrack and one sentence.
  3. Updates and receipts.
  4. `#proof`: "Every donation, on the blockchain", with LedgerTable and contract Address.
- **Mobile:** the donate panel becomes a bottom bar with the amount and the primary button.

### States and motion
- **Hover:** shift 1–3px toward the shadow.
- **Press:** shift fully into the shadow.
- **Disabled:** dashed border, `ink-muted` text, no shadow.
- **Focus:** a 3px `focus` outline with a 3px offset everywhere.
- **Motion:** only the 80ms press. Nothing fades or slides in. Honour `prefers-reduced-motion`.

### Status chips (v1.1)

| Status | Chip | Look |
|---|---|---|
| LIVE | `live` | cherry fill, ink text, `●` |
| VERIFIED, SUCCEEDED, COMPLETED, APPROVED | `verified` / `succeeded` / `completed` | `success-700` fill, white text (dark: `success-50` fill, `success-700` text), `✓` |
| VOTING | `voting` | `warning-50` fill, `warning-700` text and border, `◐` |
| IN REVIEW (campaign `PENDING_REVIEW`, KYB `PENDING`) | `in-review` | as VOTING, `…` |
| DRAFT, PENDING, IMPORTED | `pending` / `imported` | dashed outline in `ink-muted`, `○` |
| NEEDS REVIEW, FROZEN | `needs-review` / `frozen` | hatched glyph, outline |
| REJECTED, FAILED | `rejected` / `failed` | `cherry-900` fill, white text, `✕` |

The verified mark (`.ch-verified`) uses the success fill. The featured campaign card has a cherry hard shadow.

### Landing & marketing pages (v1.1)

1. Every section starts with an **eyebrow** (`.ch-eyebrow`: cherry dash + cherry text) and a **section heading** (`.ch-section-heading`: display face, 44px desktop / 30px mobile, a 72×8 cherry bar under it). App page titles (account, admin, campaigns) use the same heading.
2. Section backgrounds alternate: ground (mist) → tint (`cherry-50`) → raised (white, 3px ink rules) → dark. Never two equal bands in a row.
3. At most one solid cherry button per section.
4. The key number of a section (amount, score, count) is cherry (`wayfinding-text`).
5. Colour comes from photos; UI colour is cherry + greys; green and amber only for status.
6. Mobile: the same bands, heading 30px, the eyebrow dash stays.
7. The header has a 6px cherry top rule; the current section's nav item is cherry with a 3px cherry underline (`aria-current="page"`).

Every text/background pair of these tokens is checked for WCAG AA (4.5:1) in both themes by `apps/web/src/__tests__/design-contrast.test.ts`.

## Iconography

- **Library:** Lucide (`lucide-react`) with 2px strokes and square caps: 16px in text, 20px in buttons, `currentColor`.
- **Glyphs:** status uses typographic glyphs. Links to the explorer end in `↗`, and links to the page's own proof section end in `↓`.
- **Logos:** they live in **Logos**:
  - The cherry wordmark on light grounds, and white on dark and on cherry-700/900.
  - Ink for single-colour print.
  - The cherry symbol is the favicon.
  - Clear space equals the height of the cherry. Never place the cherry wordmark on cherry-500.
- **CHR token art** only where CHR itself is shown (Phase 2).

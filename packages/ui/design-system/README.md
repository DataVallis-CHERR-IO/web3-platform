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

- **Voice: warm, plain and exact.** Speak like a trusted friend who keeps the books. Write "Susan needs surgery by December. Every euro goes into a locked account and is released only when donors approve the hospital's receipts." Hype like "Revolutionizing giving on-chain!" is off-voice.
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
- **Cherry is the only UI colour:**
  - `accent` for the primary action, the progress fill and the Raising chip, with **one cherry block per region**.
  - Cherry text uses `accent-text`.
  - Text on cherry is ink (`on-accent`). White appears only on `accent-hover`, cherry-700 and `danger`.
- **Photos are the warmth.** Campaign photos appear in full colour and large: the detail-page hero is 8 columns wide, cards are 16:9. They show real people and places, never stock images.
- **No green, blue or yellow status colours.** State is fill style + glyph + word (`StatusChip`).
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

## Iconography

- **Library:** Lucide (`lucide-react`) with 2px strokes and square caps: 16px in text, 20px in buttons, `currentColor`.
- **Glyphs:** status uses typographic glyphs. Links to the explorer end in `↗`, and links to the page's own proof section end in `↓`.
- **Logos:** they live in **Logos**:
  - The cherry wordmark on light grounds, and white on dark and on cherry-700/900.
  - Ink for single-colour print.
  - The cherry symbol is the favicon.
  - Clear space equals the height of the cherry. Never place the cherry wordmark on cherry-500.
- **CHR token art** only where CHR itself is shown (Phase 2).

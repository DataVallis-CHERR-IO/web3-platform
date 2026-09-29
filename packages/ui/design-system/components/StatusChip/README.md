# StatusChip

**Both layers.** One fixed chip per contract / org state, in plain words. State is carried by **fill style + glyph + word**, never colour alone.

| status | label | look | contract / app state |
|---|---|---|---|
| `live` | Raising | cherry fill ● | `LIVE` |
| `voting` | Donors reviewing | cherry outline ◐ | `VOTING` |
| `succeeded` | Goal reached | ink fill ✓ | `SUCCEEDED` |
| `completed` | Completed | ink fill ✓ | `COMPLETED` |
| `verified` | Verified | ink fill ✓ | Org passed KYB / individual passed KYC |
| `pending` | In review | dashed ○ | `PENDING_REVIEW` |
| `imported` | Not on CHERR.IO yet | dashed ○ | Registry-imported org |
| `needs-review` | Team reviewing | hatched ! | `NEEDS_REVIEW` |
| `frozen` | Paused | cherry-hatched ‖ | `FROZEN` |
| `failed` | Unsuccessful | deep cherry ✕ | `FAILED` |
| `rejected` | Rejected by donors | deep cherry ✕ | `REJECTED` |

Consumer provides: `status`; `children` only to translate the label (via next-intl).

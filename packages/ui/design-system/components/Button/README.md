# Button

**Human layer.** Square, uppercase, 3px ink border, hard offset shadow; press pushes the button into its shadow.

- `variant="primary"` — cherry fill, ink text, `shadow-hard`. **One per view**: "Donate", "Approve receipts".
- `variant="secondary"` (default) — raised surface, `shadow-hard-sm`.
- `variant="ghost"` — underlined text action.
- `size="lg"` in the donate panel; `block` to fill the column on mobile.
- Label = verb + object in plain words: "Donate €25", "Share campaign". Never "Submit", never Web3 words ("Sign", "Connect wallet") in the donor flow — wallet connection is a secondary option inside the donate panel.

Consumer provides: `children`, `onClick`, native button props.

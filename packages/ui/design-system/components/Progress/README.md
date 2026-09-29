# Progress

**Human layer.** Raised vs goal in **EUR**, with the **10% success line** as a dashed tick and a plain sentence under it ("Succeeds at 10% (€2,000)" → "✓ Campaign will succeed").

- `currency="USDC"` switches to proof-layer formatting (2 decimals, USDC) — use only inside the proof layer.
- The bar never animates on load.

Consumer provides: `raised`, `target` (EUR display numbers, converted from on-chain USDC with the campaign's stored rate), optional `threshold` (0.1), `currency`, `meta`.

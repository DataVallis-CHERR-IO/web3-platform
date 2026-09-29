# Field

**Human layer.** Label above (uppercase `label`), 3px ink box, optional suffix cell. Donation amounts are entered in **EUR** (`mono` for the digits); the USDC amount is shown only in the confirmation's "details" disclosure.

- Hint explains the practical thing: "Card, Apple Pay or crypto wallet."
- Error says what to do: "The minimum donation is €1."
- Never placeholder-only labels. Focus draws a 3px `focus` outline outside the box.

Consumer provides: `label`, `hint`, `error`, `suffix`, `mono`, native input props.

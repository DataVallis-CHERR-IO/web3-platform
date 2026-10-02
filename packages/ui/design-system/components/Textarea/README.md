# Textarea

**Human layer.** The multi-line version of Field: label above (uppercase `label`), 3px ink box, radius 0, hint or error below. Used for longer plain-language answers, e.g. the short description of an organisation.

- Minimum height 120px; the user may resize it vertically only.
- Hint states the limit in plain words: "Up to 1,000 characters."
- Error says what to do. Never placeholder-only labels. Focus draws a 3px `focus` outline outside the box.

Consumer provides: `label`, `hint`, `error`, native textarea props.

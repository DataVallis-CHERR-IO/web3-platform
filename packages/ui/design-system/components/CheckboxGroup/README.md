# CheckboxGroup

**Human layer.** A multi-select from a short, fixed list (e.g. the causes an organisation works for). One uppercase `label` for the whole group (`fieldset` + `legend`), then square 24px boxes with a 3px ink border, radius 0. A checked box is filled with `accent` inside a `surface-raised` inset, so the mark is visible in both themes.

- Use for up to about a dozen options; a longer list needs a different control.
- Option labels are plain words from next-intl, never codes.
- Hint or error below the group, as in Field. Each box shows the 3px `focus` outline.

Consumer provides: `label`, `options` (`value`, `label`), `value`, `onChange`, `hint`, `error`.

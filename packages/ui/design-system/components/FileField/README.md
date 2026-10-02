# FileField

**Human layer.** One slot for one document. Label above (uppercase `label`), 3px ink box, radius 0. Empty: the box holds the browser's file picker. Filled: the box shows the state of the file in plain words ("Uploading…", "Uploaded — PDF, 240 KB") and a remove cell on the right, separated by a 3px ink line like the Field suffix.

- One file per slot; several documents are several slots, each with its own label.
- The file name chosen by the user is not shown or stored — only the state.
- Hint says what is accepted: "PDF, JPEG or PNG, up to 10 MB." Error says what to do.
- The remove cell is a real button; its accessible name includes the slot label.

Consumer provides: `label`, `hint`, `error`, `accept`, `fileLabel`, `busy`, `removeLabel`, `onSelect`, `onRemove`.

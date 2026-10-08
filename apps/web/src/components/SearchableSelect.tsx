"use client";
import * as React from "react";

/**
 * A select with type-to-filter for long lists (countries). ARIA combobox
 * pattern without a new dependency: an input (role=combobox) and a listbox.
 * Same visual language as the design system's Select (ch-field, ch-select-*).
 *
 * Keys: ArrowDown/ArrowUp move, Enter selects, Escape closes and restores the
 * chosen label. Matching ignores case and accents and also matches the value
 * (e.g. "SI").
 */
export interface SearchableSelectProps {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  error?: string;
  hint?: string;
  /** Shown in the list when nothing matches. */
  noMatch: string;
}

const fold = (text: string) => text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function filterOptions<T extends { value: string; label: string }>(options: T[], query: string): T[] {
  const q = fold(query.trim());
  if (!q) return options;
  const starts = options.filter((o) => fold(o.label).startsWith(q) || fold(o.value) === q);
  const contains = options.filter((o) => !starts.includes(o) && fold(o.label).includes(q));
  return [...starts, ...contains];
}

export function SearchableSelect(props: SearchableSelectProps) {
  const id = React.useId();
  const listId = `${id}-list`;
  const selected = props.options.find((o) => o.value === props.value);
  const [query, setQuery] = React.useState(selected?.label ?? "");
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const listRef = React.useRef<HTMLUListElement>(null);

  // Keep the input text in step with the chosen value when the list is closed.
  React.useEffect(() => {
    if (!open) setQuery(selected?.label ?? "");
  }, [selected?.label, open]);

  const typed = open && query !== (selected?.label ?? "");
  const matches = typed ? filterOptions(props.options, query) : props.options;

  React.useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function choose(value: string) {
    props.onChange(value);
    setQuery(props.options.find((o) => o.value === value)?.label ?? "");
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(Math.max(0, matches.findIndex((o) => o.value === props.value)));
      } else setActive((i) => Math.min(i + 1, matches.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      if (open && matches[active]) {
        event.preventDefault();
        choose(matches[active]!.value);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
      setQuery(selected?.label ?? "");
    }
  }

  return (
    <div className={props.error ? "ch-field ch-field-error" : "ch-field"}>
      <label className="ch-label" htmlFor={`${id}-input`}>
        {props.label}
      </label>
      <div className="relative">
        <div className="ch-field-row">
          <input
            id={`${id}-input`}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && matches[active] ? `${id}-opt-${matches[active]!.value}` : undefined}
            aria-describedby={`${id}-note`}
            aria-invalid={props.error ? "true" : undefined}
            className="ch-input"
            placeholder={props.placeholder}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
              setActive(0);
            }}
            onFocus={(event) => event.currentTarget.select()}
            onClick={(event) => {
              // The chosen name is selected, so typing replaces it and filters at once.
              event.currentTarget.select();
              setOpen(true);
              setActive(Math.max(0, props.options.findIndex((o) => o.value === props.value)));
            }}
            onKeyDown={onKeyDown}
            onBlur={() => {
              // Let a click on an option land first.
              setTimeout(() => setOpen(false), 120);
            }}
          />
          <span className="ch-field-suffix ch-select-icon" aria-hidden="true">
            ▾
          </span>
        </div>
        {open && (
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={props.label}
            className="ch-select-content ch-select-viewport absolute left-0 right-0 mt-1 max-h-72 overflow-y-auto"
          >
            {matches.length === 0 ? (
              <li className="ch-select-item" aria-disabled="true">
                {props.noMatch}
              </li>
            ) : (
              matches.map((option, index) => (
                <li
                  key={option.value}
                  id={`${id}-opt-${option.value}`}
                  role="option"
                  aria-selected={option.value === props.value}
                  data-index={index}
                  data-highlighted={index === active ? "" : undefined}
                  className="ch-select-item"
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(option.value)}
                >
                  {option.label}
                </li>
              ))
            )}
          </ul>
        )}
      </div>
      <span id={`${id}-note`} className="ch-field-hint">
        {props.error ?? props.hint}
      </span>
    </div>
  );
}

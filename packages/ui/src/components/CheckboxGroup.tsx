/**
 * CheckboxGroup — Human layer.
 * A labelled group of square checkboxes (fieldset + legend) for a multi-select
 * from a short fixed list. Option labels come from next-intl.
 */
import * as React from "react";
import { cn } from "../lib/utils";

export interface CheckboxGroupProps {
  label: string;
  options: { value: string; label: string }[];
  value: string[];
  onChange: (value: string[]) => void;
  hint?: string;
  error?: string;
  className?: string;
}

export function CheckboxGroup({ label, options, value, onChange, hint, error, className }: CheckboxGroupProps) {
  const noteId = React.useId();
  const toggle = (option: string, checked: boolean) =>
    onChange(checked ? [...value, option] : value.filter((v) => v !== option));

  return (
    <fieldset
      className={cn("ch-field ch-checkbox-group", error && "ch-field-error", className)}
      aria-describedby={hint || error ? noteId : undefined}
    >
      <legend className="ch-label">{label}</legend>
      <div className="ch-checkbox-list">
        {options.map((option) => (
          <label key={option.value} className="ch-checkbox">
            <input
              type="checkbox"
              checked={value.includes(option.value)}
              onChange={(event) => toggle(option.value, event.target.checked)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      {(hint || error) && (
        <span id={noteId} className="ch-field-hint">
          {error ?? hint}
        </span>
      )}
    </fieldset>
  );
}

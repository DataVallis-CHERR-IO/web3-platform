"use client";
import * as React from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@cherrio/ui";

/** The design system's Select with the label, hint and error of a Field. */
export function LabeledSelect(props: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  error?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const id = React.useId();
  return (
    <div className={props.error ? "ch-field ch-field-error" : "ch-field"}>
      <span className="ch-label" id={`${id}-label`}>
        {props.label}
      </span>
      <Select value={props.value || undefined} onValueChange={props.onChange} disabled={props.disabled}>
        <SelectTrigger aria-labelledby={`${id}-label`} aria-describedby={`${id}-note`}>
          <SelectValue placeholder={props.placeholder} />
        </SelectTrigger>
        <SelectContent className="max-h-72 overflow-y-auto">
          {props.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span id={`${id}-note`} className="ch-field-hint">
        {props.error ?? props.hint}
      </span>
    </div>
  );
}

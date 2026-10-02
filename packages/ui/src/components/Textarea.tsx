/**
 * Textarea — Human layer.
 * Multi-line Field: label above (uppercase), 3px ink box, hint or error below.
 */
import * as React from "react";
import { cn } from "../lib/utils";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: string;
  error?: string;
}

export function Textarea({ label, hint, error, className, id, rows = 5, ...props }: TextareaProps) {
  const generatedId = React.useId();
  const fieldId = id ?? generatedId;
  const noteId = hint || error ? `${fieldId}-note` : undefined;

  return (
    <div className={cn("ch-field", error && "ch-field-error", className)}>
      <label className="ch-label" htmlFor={fieldId}>
        {label}
      </label>
      <div className="ch-field-row">
        <textarea
          id={fieldId}
          rows={rows}
          className="ch-input ch-textarea"
          aria-describedby={noteId}
          aria-invalid={error ? "true" : undefined}
          {...props}
        />
      </div>
      {noteId && (
        <span id={noteId} className="ch-field-hint">
          {error ?? hint}
        </span>
      )}
    </div>
  );
}

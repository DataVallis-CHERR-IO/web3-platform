/**
 * Field — Human layer.
 * Label above (uppercase), 3px ink box, optional suffix cell.
 * Donation amounts use mono digits. Focus ring outside the box.
 */
import * as React from "react";
import { cn } from "../lib/utils";

export interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
  suffix?: string;
  mono?: boolean;
}

export function Field({ label, hint, error, suffix, mono = false, className, id, ...props }: FieldProps) {
  const fieldId = id ?? `field-${label.toLowerCase().replace(/\s+/g, "-")}`;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("ch-field", error && "ch-field-error", className)}>
      <label className="ch-label" htmlFor={fieldId}>
        {label}
      </label>
      <div className="ch-field-row">
        <input
          id={fieldId}
          className={cn("ch-input", mono && "ch-input-mono")}
          aria-describedby={describedBy}
          aria-invalid={error ? "true" : undefined}
          {...props}
        />
        {suffix && (
          <span className="ch-field-suffix" aria-hidden="true">
            {suffix}
          </span>
        )}
      </div>
      {(hint || error) && (
        <span id={error ? errorId : hintId} className="ch-field-hint">
          {error ?? hint}
        </span>
      )}
    </div>
  );
}

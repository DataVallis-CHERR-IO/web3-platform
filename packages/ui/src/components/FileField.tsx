/**
 * FileField — Human layer.
 * One document slot: label above, 3px ink box with the native file picker.
 * Once a file is chosen the box shows its state (`fileLabel`) and a remove
 * button instead. All texts come from next-intl via props.
 */
import * as React from "react";
import { cn } from "../lib/utils";

export interface FileFieldProps {
  label: string;
  hint?: string;
  error?: string;
  /** e.g. ".pdf,.jpg,.jpeg,.png" */
  accept?: string;
  /** Set while a file is uploading or uploaded: shown instead of the picker. */
  fileLabel?: string;
  busy?: boolean;
  removeLabel: string;
  onSelect: (file: File) => void;
  onRemove: () => void;
  className?: string;
}

export function FileField({
  label, hint, error, accept, fileLabel, busy = false, removeLabel, onSelect, onRemove, className,
}: FileFieldProps) {
  const fieldId = React.useId();
  const noteId = hint || error ? `${fieldId}-note` : undefined;

  return (
    <div className={cn("ch-field", error && "ch-field-error", className)}>
      <label className="ch-label" htmlFor={fieldId}>
        {label}
      </label>
      <div className="ch-field-row ch-file-row">
        {fileLabel ? (
          <>
            <span className="ch-file-name" role="status" aria-busy={busy}>
              {fileLabel}
            </span>
            <button
              type="button"
              id={fieldId}
              className="ch-field-suffix ch-file-remove"
              onClick={onRemove}
              disabled={busy}
              aria-label={`${removeLabel}: ${label}`}
            >
              {removeLabel}
            </button>
          </>
        ) : (
          <input
            id={fieldId}
            type="file"
            accept={accept}
            className="ch-input ch-file-input"
            aria-describedby={noteId}
            aria-invalid={error ? "true" : undefined}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onSelect(file);
              event.target.value = "";
            }}
          />
        )}
      </div>
      {noteId && (
        <span id={noteId} className="ch-field-hint">
          {error ?? hint}
        </span>
      )}
    </div>
  );
}

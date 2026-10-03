/**
 * StatusChip — Both layers.
 * State = fill style + glyph + word. Never colour alone.
 * Labels must come from next-intl via children; the glyph is aria-hidden.
 */
import * as React from "react";
import { cn } from "../lib/utils";

export type Status =
  | "live"
  | "voting"
  | "succeeded"
  | "completed"
  | "verified"
  | "pending"
  | "in-review"
  | "imported"
  | "needs-review"
  | "frozen"
  | "failed"
  | "rejected";

export interface StatusChipProps {
  status: Status;
  /** Translated label from useTranslations('ui.status')[status] */
  children: React.ReactNode;
}

const CHIP_CONFIG: Record<Status, { glyphClass: string; chipClass: string; glyph: string }> = {
  live:         { chipClass: "ch-chip-live",         glyphClass: "ch-chip-glyph", glyph: "●" },
  voting:       { chipClass: "ch-chip-voting",        glyphClass: "ch-chip-glyph", glyph: "◐" },
  succeeded:    { chipClass: "ch-chip-solid",         glyphClass: "ch-chip-glyph", glyph: "✓" },
  completed:    { chipClass: "ch-chip-solid",         glyphClass: "ch-chip-glyph", glyph: "✓" },
  verified:     { chipClass: "ch-chip-solid",         glyphClass: "ch-chip-glyph", glyph: "✓" },
  pending:      { chipClass: "ch-chip-outline",       glyphClass: "ch-chip-glyph", glyph: "○" },
  "in-review":  { chipClass: "ch-chip-review",        glyphClass: "ch-chip-glyph", glyph: "…" },
  imported:     { chipClass: "ch-chip-outline",       glyphClass: "ch-chip-glyph", glyph: "○" },
  "needs-review": { chipClass: "ch-chip-hatch",      glyphClass: "ch-chip-glyph", glyph: "!" },
  frozen:       { chipClass: "ch-chip-hatch-accent",  glyphClass: "ch-chip-glyph", glyph: "‖" },
  failed:       { chipClass: "ch-chip-danger",        glyphClass: "ch-chip-glyph", glyph: "✕" },
  rejected:     { chipClass: "ch-chip-danger",        glyphClass: "ch-chip-glyph", glyph: "✕" },
};

export function StatusChip({ status, children }: StatusChipProps) {
  const { chipClass, glyphClass, glyph } = CHIP_CONFIG[status];
  return (
    <span className={cn("ch-chip", chipClass)}>
      <span className={glyphClass} aria-hidden="true">{glyph}</span>
      {children}
    </span>
  );
}

/**
 * ProofLink — Bridge between human and proof layers.
 * href="#proof" scrolls to page proof section (↓); external opens explorer (↗).
 * Default label: "Verified on blockchain" (pass as children from next-intl).
 */
import * as React from "react";
import { cn } from "../lib/utils";

export interface ProofLinkProps {
  href?: string;
  external?: boolean;
  children?: React.ReactNode;
  className?: string;
}

export function ProofLink({ href = "#proof", external = false, children, className }: ProofLinkProps) {
  const arrow = external ? "↗" : "↓";
  return (
    <a
      href={href}
      className={cn("ch-proof", className)}
      {...(external
        ? { target: "_blank", rel: "noopener noreferrer" }
        : {})}
    >
      {children}
      <span className="ch-proof-mark" aria-hidden="true">
        {arrow}
      </span>
    </a>
  );
}

/**
 * Address — Proof layer.
 * Shows a checksummed on-chain address truncated to 6+4, with copy button.
 * Copy label toggles to "COPIED!" on success via local state.
 */
"use client";
import * as React from "react";
import { cn } from "../lib/utils";

export interface AddressProps {
  address: string;
  leadChars?: number;
  tailChars?: number;
  copyLabel?: string;
  copiedLabel?: string;
  className?: string;
}

export function Address({
  address,
  leadChars = 6,
  tailChars = 4,
  copyLabel = "COPY",
  copiedLabel = "COPIED!",
  className,
}: AddressProps) {
  const [copied, setCopied] = React.useState(false);

  const display =
    address.length > leadChars + tailChars + 2
      ? `${address.slice(0, leadChars)}…${address.slice(-tailChars)}`
      : address;

  function handleCopy() {
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <span className={cn("ch-addr", className)}>
      <span className="ch-addr-text ch-mono" title={address}>
        {display}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={`Copy address ${address}`}
      >
        {copied ? copiedLabel : copyLabel}
      </button>
    </span>
  );
}

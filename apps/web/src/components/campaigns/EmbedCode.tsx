"use client";
import * as React from "react";
import { useTranslations } from "next-intl";

/** "Put this campaign on your website" (TASK-019): the widget code to copy. */
export function EmbedCode({ code }: { code: string }) {
  const t = useTranslations("widget");
  const [copied, setCopied] = React.useState(false);
  const id = React.useId();
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard refused (permissions): the code stays selectable in the box.
    }
  }
  return (
    <details className="ch-embed">
      <summary className="ch-embed-summary">{t("embedTitle")}</summary>
      <div className="ch-embed-body">
        <p className="m-0 text-sm">{t("embedHelp")}</p>
        <label htmlFor={id} className="sr-only">
          {t("embedCode")}
        </label>
        <textarea id={id} className="ch-embed-code" readOnly rows={4} value={code} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="ch-share-copy-btn self-start" onClick={copy}>
          {copied ? t("copied") : t("copy")}
        </button>
      </div>
    </details>
  );
}

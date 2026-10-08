"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { POINTS } from "@cherrio/shared/points";
import { SHARE_ICON_PATHS } from "./share-icons";

// Share box on the campaign page (TASK-055, ADR-057 §5; compact redesign TASK-058). A signed-in user
// shares a personal link (`?ref=<code>`, from GET /api/me/referral-code); when
// someone donates through it, it counts for them (points: TASK-056). Without a
// session the plain campaign link is shared. Sharing itself earns nothing.

export interface CampaignShareProps {
  /** Public campaign URL without a code. */
  url: string;
  title: string;
}

type Network = { key: "x" | "facebook" | "linkedin" | "whatsapp" | "telegram" | "email"; href: (url: string, text: string) => string };

const enc = encodeURIComponent;

export const SHARE_NETWORKS: Network[] = [
  { key: "x", href: (url, text) => `https://x.com/intent/tweet?text=${enc(text)}&url=${enc(url)}` },
  { key: "facebook", href: (url) => `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}` },
  { key: "linkedin", href: (url) => `https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}` },
  { key: "whatsapp", href: (url, text) => `https://wa.me/?text=${enc(`${text} ${url}`)}` },
  { key: "telegram", href: (url, text) => `https://t.me/share/url?url=${enc(url)}&text=${enc(text)}` },
  { key: "email", href: (url, text) => `mailto:?subject=${enc(text)}&body=${enc(`${text}\n\n${url}`)}` },
];

/** The campaign URL with the personal code (same rule as the server's campaignShareUrl). */
export function withRefCode(url: string, code: string | null): string {
  if (!code) return url;
  const u = new URL(url);
  u.searchParams.set("ref", code);
  return u.toString();
}

export function CampaignShare({ url, title }: CampaignShareProps) {
  const t = useTranslations("campaignPage.share");
  const [code, setCode] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [canNativeShare, setCanNativeShare] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    setCanNativeShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
    fetch("/api/me/referral-code", { cache: "no-store" })
      // Always read the body (an unread one keeps the request open in the browser).
      .then((r) => (r.ok ? (r.json() as Promise<{ code?: string }>) : r.text().then(() => null)))
      .then((body) => {
        if (alive && body?.code) setCode(body.code);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const link = withRefCode(url, code);
  const text = t("text", { title });

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }

  async function nativeShare() {
    try {
      await navigator.share({ title, text, url: link });
    } catch {
      // closed by the user
    }
  }

  // The link as people read it (no scheme); the copy button copies the full link.
  const shown = link.replace(/^https?:\/\//, "");

  return (
    <section className="ch-share" aria-labelledby="share-heading">
      <span className="ch-eyebrow" id="share-heading">
        {t("heading")}
      </span>
      {code ? (
        <p className="ch-share-reward">
          <span className="ch-share-reward-points">{t("rewardPoints", { points: POINTS.referralDonor })}</span>
          <span>{t("personalNote")}</span>
        </p>
      ) : (
        <p className="ch-share-note">{t("signInNote")}</p>
      )}
      <div className="ch-share-copy">
        {/* Long links are cut at the start, so the personal code at the end stays visible. */}
        <span className="ch-share-url" title={link}>
          <bdi dir="ltr">{shown}</bdi>
        </span>
        <button type="button" className="ch-share-copy-btn" onClick={copy} aria-label={copied ? t("copied") : t("copy")}>
          {copied ? t("copiedShort") : t("copyShort")}
        </button>
      </div>
      <ul className="ch-share-icons">
        {SHARE_NETWORKS.map((n) => (
          <li key={n.key}>
            <a
              className="ch-share-icon"
              href={n.href(link, text)}
              target={n.key === "email" ? undefined : "_blank"}
              rel="noopener noreferrer"
              aria-label={t("on", { network: t(`networks.${n.key}`) })}
              title={t(`networks.${n.key}`)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d={SHARE_ICON_PATHS[n.key]} />
              </svg>
            </a>
          </li>
        ))}
        {canNativeShare && (
          <li>
            <button type="button" className="ch-share-icon" onClick={nativeShare} aria-label={t("more")} title={t("more")}>
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M5 10.5a2 2 0 1 1 0 3 2 2 0 0 1 0-3Zm7 0a2 2 0 1 1 0 3 2 2 0 0 1 0-3Zm7 0a2 2 0 1 1 0 3 2 2 0 0 1 0-3Z" />
              </svg>
            </button>
          </li>
        )}
      </ul>
      <span className="ch-sr-only" role="status" aria-live="polite">
        {copied ? t("copied") : ""}
      </span>
    </section>
  );
}

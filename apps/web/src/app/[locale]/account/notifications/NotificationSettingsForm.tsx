"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { Button, Field } from "@cherrio/ui";
import type { NotificationSettings } from "@/lib/notifications/preferences";

const ERRORS = ["email_invalid", "same_as_login", "same_as_contact", "too_many_requests"] as const;

export function NotificationSettingsForm({ initial }: { initial: NotificationSettings }) {
  const t = useTranslations("notifications");
  const [s, setS] = React.useState(initial);
  const [email, setEmail] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const call = async (url: string, method: string, body?: unknown) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(url, {
        method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined,
      });
      const json = (await res.json().catch(() => ({}))) as NotificationSettings & { error?: string };
      if (!res.ok) {
        const code = ERRORS.find((c) => c === json.error);
        setMessage({ kind: "error", text: code ? t(`errors.${code}`) : t("errors.failed") });
        return false;
      }
      setS(json);
      return true;
    } catch {
      setMessage({ kind: "error", text: t("errors.failed") });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const walletOnly = !s.loginEmail;
  const status = !s.emailEnabled ? t("statusOff") : s.sendsTo ? t("statusOn", { email: s.sendsTo }) : t("statusNoAddress");

  return (
    <div className="flex flex-col gap-6">
      <section className="ch-panel p-6 flex flex-col gap-3" aria-labelledby="email-status">
        <p id="email-status" className="text-base font-bold text-[var(--ink)]" role="status">{status}</p>
        {s.loginEmail && <p className="text-sm text-[var(--ink)]">{t("loginEmail", { email: s.loginEmail })}</p>}
        <label className="flex items-start gap-3 text-base text-[var(--ink)]">
          <input
            type="checkbox"
            className="mt-1"
            checked={s.emailEnabled}
            disabled={busy}
            aria-describedby="email-toggle-hint"
            onChange={(e) => void call("/api/me/notifications", "PUT", { emailEnabled: e.target.checked }).then((ok) => ok && setMessage({ kind: "ok", text: t("saved") }))}
          />
          <span className="flex flex-col">
            {t("toggleLabel")}
            <span id="email-toggle-hint" className="text-sm text-[var(--ink-muted)]">{t("toggleHint")}</span>
          </span>
        </label>
      </section>

      <section className="ch-panel p-6 flex flex-col gap-3" aria-labelledby="contact-title">
        <h2 id="contact-title" className="text-xl font-display uppercase text-[var(--ink)]">
          {s.contactEmail ? t("contactTitleChange") : walletOnly ? t("contactTitleWallet") : t("contactTitle")}
        </h2>
        <p className="text-sm text-[var(--ink)]">
          {s.contactEmail ? t("contactTextChange") : walletOnly ? t("contactText") : t("contactTextOther")}
        </p>
        {s.contactEmail && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-base text-[var(--ink)]">{t("contactCurrent", { email: s.contactEmail })}</span>
            <Button variant="ghost" disabled={busy} onClick={() => void call("/api/me/notifications/email", "DELETE")}>
              {t("contactRemove")}
            </Button>
          </div>
        )}
        {s.pendingEmail && <p className="ch-notice m-0" role="status">{t("pending", { email: s.pendingEmail })}</p>}
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void call("/api/me/notifications/email", "POST", { email }).then((ok) => ok && setEmail(""));
          }}
        >
          <Field label={s.contactEmail ? t("contactLabelNew") : t("contactLabel")} type="email" autoComplete="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} />
          <div>
            <Button type="submit" disabled={busy || email.trim().length < 3}>{t("contactSave")}</Button>
          </div>
        </form>
      </section>

      {message && (
        <p role={message.kind === "error" ? "alert" : "status"} className="text-base font-bold text-[var(--ink)]">{message.text}</p>
      )}
    </div>
  );
}

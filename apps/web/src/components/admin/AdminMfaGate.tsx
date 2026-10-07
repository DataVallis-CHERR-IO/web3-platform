"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Field } from "@cherrio/ui";

interface Enrolment {
  secret: string;
  qrDataUrl: string;
}

/**
 * The admin second factor (ADR-056). Rendered by the admin layout instead of
 * the page: `enrol` when the admin has no confirmed authenticator yet, `verify`
 * when the 12-hour proof cookie is missing or expired.
 */
export function AdminMfaGate({ mode }: { mode: "enrol" | "verify" }) {
  const t = useTranslations("admin.mfa");
  const router = useRouter();
  const [enrolment, setEnrolment] = React.useState<Enrolment | null>(null);
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[] | null>(null);
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function post<T>(path: string, body: object = {}): Promise<T | null> {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/mfa/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (!res.ok) {
        const key = `errors.${data.error ?? "failed"}`;
        setError(t.has(key as never) ? t(key as never) : t("errors.failed"));
        return null;
      }
      return data;
    } catch {
      setError(t("errors.failed"));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    const data = await post<Enrolment>("enroll");
    if (data) setEnrolment(data);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === "enrol") {
      const data = await post<{ recoveryCodes: string[] }>("confirm", { code: code.trim() });
      if (data) setRecoveryCodes(data.recoveryCodes);
    } else {
      const data = await post<{ recoveryCodesLeft: number }>("verify", { code: code.trim() });
      if (data) router.refresh();
    }
    setCode("");
  }

  const errorBox = error ? (
    <p role="alert" className="ch-panel p-3 text-sm font-bold text-[var(--ink)]">
      {error}
    </p>
  ) : null;

  const codeForm = (label: string, hint: string, submitLabel: string, inputMode: "numeric" | "text") => (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <Field
        id="admin-mfa-code"
        label={label}
        hint={hint}
        type="text"
        inputMode={inputMode}
        autoComplete="one-time-code"
        spellCheck={false}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        mono
        required
        autoFocus
      />
      <Button type="submit" disabled={busy || code.trim().length < 6}>
        {submitLabel}
      </Button>
    </form>
  );

  let body: React.ReactNode;
  if (mode === "verify") {
    body = (
      <>
        <p className="text-[var(--ink)]">{t("verify.intro")}</p>
        {codeForm(t("verify.code"), t("verify.codeHint"), t("verify.submit"), "text")}
      </>
    );
  } else if (recoveryCodes) {
    body = (
      <>
        <p className="text-[var(--ink)] font-bold">{t("enrol.done")}</p>
        <p className="text-[var(--ink)]">{t("enrol.recoveryIntro")}</p>
        <ol aria-label={t("enrol.recoveryList")} className="ch-panel ch-mono p-4 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[var(--ink)]">
          {recoveryCodes.map((c) => (
            <li key={c} className="whitespace-nowrap">{c}</li>
          ))}
        </ol>
        <Button type="button" onClick={() => router.refresh()}>
          {t("enrol.continue")}
        </Button>
      </>
    );
  } else if (enrolment) {
    body = (
      <>
        <p className="text-[var(--ink)]">{t("enrol.scan")}</p>
        <img src={enrolment.qrDataUrl} alt={t("enrol.qrAlt")} width={220} height={220} className="ch-panel bg-[var(--white)] self-start" />
        <p className="text-sm text-[var(--ink)]">
          {t("enrol.manual")} <code className="ch-mono font-bold break-all" data-testid="mfa-secret">{enrolment.secret}</code>
        </p>
        {codeForm(t("enrol.code"), t("enrol.codeHint"), t("enrol.submit"), "numeric")}
      </>
    );
  } else {
    body = (
      <>
        <p className="text-[var(--ink)]">{t("enrol.intro")}</p>
        <Button type="button" onClick={() => void start()} disabled={busy}>
          {t("enrol.start")}
        </Button>
      </>
    );
  }

  return (
    <div className="ch-container py-12">
      <section className="ch-panel p-6 flex flex-col gap-4 max-w-xl" aria-labelledby="admin-mfa-heading">
        <h1 id="admin-mfa-heading" className="text-2xl font-bold text-[var(--ink)]">
          {t(mode === "enrol" ? "enrol.title" : "verify.title")}
        </h1>
        {errorBox}
        {body}
      </section>
    </div>
  );
}

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Field } from "@cherrio/ui";

interface Created {
  created: { id: string; title: string; durationDays: number }[];
}

/** Creates a batch of demo campaigns (ADR-052) and refreshes the list. */
export function DemoForm({ max, defaultPayout }: { max: number; defaultPayout: string }) {
  const t = useTranslations("admin.demo.form");
  const router = useRouter();
  const [count, setCount] = React.useState(Math.min(5, max));
  const [payoutAddress, setPayoutAddress] = React.useState(defaultPayout);
  const [durationMode, setDurationMode] = React.useState<"mixed" | "short">("mixed");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);
  const validAddress = /^0x[0-9a-fA-F]{40}$/.test(payoutAddress.trim());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(null);
    if (!validAddress) {
      setError(t("errors.validation_failed"));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/admin/demo-campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count, payoutAddress: payoutAddress.trim(), durationMode }),
      });
      if (!res.ok) {
        const code = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "failed";
        setError(t.has(`errors.${code}` as never) ? t(`errors.${code}` as never) : t("errors.failed"));
        return;
      }
      const data = (await res.json()) as Created;
      setDone(t("created", { count: data.created.length }));
      router.refresh();
    } catch {
      setError(t("errors.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="ch-panel p-5 flex flex-col gap-4 max-w-2xl" aria-labelledby="demo-form-heading">
      <h2 id="demo-form-heading" className="text-xl font-bold text-[var(--ink)]">
        {t("title")}
      </h2>
      <Field
        id="demo-count"
        label={t("count", { max })}
        type="number"
        min={1}
        max={max}
        value={count}
        onChange={(e) => setCount(Math.max(1, Math.min(max, Number(e.target.value) || 1)))}
        mono
        required
      />
      <Field
        id="demo-payout"
        label={t("payout")}
        hint={t("payoutHint")}
        type="text"
        value={payoutAddress}
        onChange={(e) => setPayoutAddress(e.target.value)}
        placeholder="0x…"
        spellCheck={false}
        autoComplete="off"
        mono
        required
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="ch-label">{t("duration")}</legend>
        {(["mixed", "short"] as const).map((mode) => (
          <label key={mode} className="flex items-center gap-2 text-[var(--ink)]">
            <input type="radio" name="durationMode" value={mode} checked={durationMode === mode} onChange={() => setDurationMode(mode)} />
            {t(`durations.${mode}`)}
          </label>
        ))}
      </fieldset>
      <div>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t("creating") : t("submit", { count })}
        </Button>
      </div>
      {error && (
        <p role="alert" className="p-3 border-2 border-[var(--ink)] bg-[var(--surface)] text-sm font-bold text-[var(--ink)]">
          {error}
        </p>
      )}
      {done && <p role="status" className="text-sm text-[var(--ink)]">{done}</p>}
    </form>
  );
}

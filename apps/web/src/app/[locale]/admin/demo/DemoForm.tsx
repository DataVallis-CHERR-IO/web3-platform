"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Field } from "@cherrio/ui";
import { CoverGenerator } from "./CoverGenerator";

interface Created {
  created: { id: string; title: string; durationDays: number }[];
}

type State = "PENDING_REVIEW" | "APPROVED";

/**
 * Creates demo organisations and their campaigns (ADR-053) and refreshes the
 * list; covers are generated right after (038b).
 */
export function DemoForm({
  max,
  maxNewOrganizations,
  maxPerOrganization,
  existingOrganizations,
  defaultPayout,
}: {
  max: number;
  maxNewOrganizations: number;
  maxPerOrganization: number;
  existingOrganizations: number;
  defaultPayout: string;
}) {
  const t = useTranslations("admin.demo.form");
  const router = useRouter();
  const [newOrganizations, setNewOrganizations] = React.useState(2);
  const [perOrganization, setPerOrganization] = React.useState(2);
  const [state, setState] = React.useState<State>("APPROVED");
  const [payoutAddress, setPayoutAddress] = React.useState(defaultPayout);
  const [durationMode, setDurationMode] = React.useState<"mixed" | "short">("mixed");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);
  const [createdIds, setCreatedIds] = React.useState<string[]>([]);
  const validAddress = /^0x[0-9a-fA-F]{40}$/.test(payoutAddress.trim());
  const total = newOrganizations * perOrganization;
  const tooMany = total > max;
  const clamp = (value: string, low: number, high: number) => Math.max(low, Math.min(high, Math.floor(Number(value)) || low));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(null);
    setCreatedIds([]);
    if (!validAddress) {
      setError(t("errors.validation_failed"));
      return;
    }
    if (tooMany) {
      setError(t("errors.batch_too_large", { max }));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/admin/demo-campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          newOrganizations,
          campaignsPerOrganization: perOrganization,
          state,
          payoutAddress: payoutAddress.trim(),
          durationMode,
        }),
      });
      if (!res.ok) {
        const code = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "failed";
        setError(t.has(`errors.${code}` as never) ? t(`errors.${code}` as never, { max }) : t("errors.failed"));
        return;
      }
      const data = (await res.json()) as Created;
      setDone(t(state === "APPROVED" ? "createdApproved" : "createdInReview", { count: data.created.length }));
      setCreatedIds(data.created.map((c) => c.id));
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
        id="demo-new-orgs"
        label={t("newOrganizations", { max: maxNewOrganizations })}
        hint={t("newOrganizationsHint", { count: existingOrganizations })}
        type="number"
        min={0}
        max={maxNewOrganizations}
        value={newOrganizations}
        onChange={(e) => setNewOrganizations(clamp(e.target.value, 0, maxNewOrganizations))}
        mono
        required
      />
      <Field
        id="demo-per-org"
        label={t("perOrganization", { max: maxPerOrganization })}
        hint={newOrganizations > 0 ? t("total", { count: total, max }) : t("totalExisting", { max })}
        type="number"
        min={1}
        max={maxPerOrganization}
        value={perOrganization}
        onChange={(e) => setPerOrganization(clamp(e.target.value, 1, maxPerOrganization))}
        mono
        required
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="ch-label">{t("state")}</legend>
        {(["APPROVED", "PENDING_REVIEW"] as const).map((value) => (
          <label key={value} className="flex items-center gap-2 text-[var(--ink)]">
            <input type="radio" name="state" value={value} checked={state === value} onChange={() => setState(value)} />
            {t(`states.${value}`)}
          </label>
        ))}
      </fieldset>
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
          {busy ? t("creating") : t("submit")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="p-3 border-2 border-[var(--ink)] bg-[var(--surface)] text-sm font-bold text-[var(--ink)]">
          {error}
        </p>
      )}
      {done && <p role="status" className="text-sm text-[var(--ink)]">{done}</p>}
      {createdIds.length > 0 && <CoverGenerator key={createdIds.join(",")} ids={createdIds} auto />}
    </form>
  );
}

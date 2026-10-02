"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { Button, Field, FileField, Textarea } from "@cherrio/ui";
import { ORGANIZATION_CAUSES } from "@cherrio/shared/organizations";
import { campaignDraftSchema } from "@cherrio/shared/campaigns";
import { LabeledSelect } from "@/components/LabeledSelect";

export interface CampaignFormValues {
  organizationId: string;
  title: string;
  story: string;
  cause: string;
  country: string;
  targetEur: string;
  durationDays: string;
}

type Option = { value: string; label: string };

/** Create a draft (no `campaignId`) or edit one; with an id also the cover image and "Submit for review". */
export function CampaignForm(props: {
  campaignId?: string;
  initial: CampaignFormValues;
  organizations: Option[];
  countries: Option[];
  coverUrl?: string;
}) {
  const t = useTranslations("campaigns");
  const tCauses = useTranslations("organizations.form.causeNames");
  const tErrors = useTranslations("campaigns.errors");
  const router = useRouter();
  const { campaignId } = props;

  const [values, setValues] = React.useState(props.initial);
  const [invalid, setInvalid] = React.useState<string[]>([]);
  const [message, setMessage] = React.useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [cover, setCover] = React.useState<{ url?: string; uploading?: boolean; error?: string }>({
    url: props.coverUrl,
  });

  const set = (key: keyof CampaignFormValues, value: string) => setValues((current) => ({ ...current, [key]: value }));
  const fieldError = (field: string) => (invalid.includes(field) ? t(`fieldErrors.${field}` as never) : undefined);
  const errorText = (code: string | undefined) =>
    code && tErrors.has(code as never) ? tErrors(code as never) : t("failed");

  /** Sends one request; returns the JSON on success, or shows the error and returns null. */
  async function send(url: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(url, init);
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) return json;
      if (Array.isArray(json.fields)) setInvalid(json.fields as string[]);
      setMessage({ text: errorText(json.error as string | undefined), error: true });
    } catch {
      setMessage({ text: t("failed"), error: true });
    }
    return null;
  }

  async function save(): Promise<boolean> {
    setMessage(null);
    const draft = {
      title: values.title,
      story: values.story,
      cause: values.cause,
      country: values.country,
      targetEur: /^\d+$/.test(values.targetEur.trim()) ? Number(values.targetEur.trim()) : NaN,
      durationDays: /^\d+$/.test(values.durationDays.trim()) ? Number(values.durationDays.trim()) : NaN,
    };
    const parsed = campaignDraftSchema.safeParse(draft);
    const problems = parsed.success ? [] : parsed.error.issues.map((issue) => String(issue.path[0]));
    if (!campaignId && !values.organizationId) problems.push("organizationId");
    setInvalid([...new Set(problems)]);
    if (problems.length > 0) return false;

    const json = await send(campaignId ? `/api/campaigns/${campaignId}` : "/api/campaigns", {
      method: campaignId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(campaignId ? draft : { ...draft, organizationId: values.organizationId }),
    });
    if (!json) return false;
    if (!campaignId) router.push(`/account/campaigns/${json.id as string}`);
    else setMessage({ text: t("saved"), error: false });
    return true;
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    await action();
    setBusy(false);
  }

  async function submitForReview() {
    if (!(await save())) return;
    if (await send(`/api/campaigns/${campaignId}/submit`, { method: "POST" })) router.refresh();
  }

  async function uploadCover(file: File) {
    setCover((current) => ({ ...current, uploading: true, error: undefined }));
    const body = new FormData();
    body.set("file", file);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/cover`, { method: "POST", body });
      const json = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      setCover(res.ok && json.url ? { url: json.url } : { url: cover.url, error: errorText(json.error) });
    } catch {
      setCover({ url: cover.url, error: t("failed") });
    }
  }

  const card = "ch-card p-6 md:p-8 flex flex-col gap-5";
  return (
    <form
      noValidate
      className="flex flex-col gap-8"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => void (await save()));
      }}
    >
      <section className={card}>
        {!campaignId && (
          <LabeledSelect
            label={t("organization")}
            placeholder={t("organizationPlaceholder")}
            value={values.organizationId}
            onChange={(value) => set("organizationId", value)}
            options={props.organizations}
            error={fieldError("organizationId")}
          />
        )}
        <Field
          label={t("title")}
          hint={t("titleHint")}
          error={fieldError("title")}
          value={values.title}
          onChange={(event) => set("title", event.target.value)}
          maxLength={120}
        />
        <Textarea
          label={t("story")}
          hint={t("storyHint")}
          error={fieldError("story")}
          value={values.story}
          onChange={(event) => set("story", event.target.value)}
          maxLength={10000}
          rows={10}
        />
        <LabeledSelect
          label={t("cause")}
          placeholder={t("causePlaceholder")}
          value={values.cause}
          onChange={(value) => set("cause", value)}
          options={ORGANIZATION_CAUSES.map((value) => ({ value, label: tCauses(value) }))}
          error={fieldError("cause")}
        />
        <LabeledSelect
          label={t("country")}
          placeholder={t("countryPlaceholder")}
          value={values.country}
          onChange={(value) => set("country", value)}
          options={props.countries}
          error={fieldError("country")}
        />
        <Field
          label={t("targetEur")}
          hint={t("targetEurHint")}
          error={fieldError("targetEur")}
          value={values.targetEur}
          onChange={(event) => set("targetEur", event.target.value)}
          inputMode="numeric"
          suffix="EUR"
          mono
        />
        <Field
          label={t("durationDays")}
          hint={t("durationDaysHint")}
          error={fieldError("durationDays")}
          value={values.durationDays}
          onChange={(event) => set("durationDays", event.target.value)}
          inputMode="numeric"
          suffix={t("days")}
          mono
        />
      </section>

      <section className={card}>
        {campaignId ? (
          <>
            {cover.url && (
              // A plain <img>: the file is served by the public media bucket, not by Next.
              <img src={cover.url} alt={t("coverAlt")} className="w-full max-w-xl border-2 border-[var(--ink)]" />
            )}
            <FileField
              label={t("cover")}
              hint={t("coverHint")}
              error={cover.error}
              accept=".jpg,.jpeg,.png,.webp"
              fileLabel={cover.uploading ? t("uploading") : cover.url ? t("coverUploaded") : undefined}
              busy={cover.uploading}
              removeLabel={t("replace")}
              onSelect={uploadCover}
              onRemove={() => setCover({})}
            />
          </>
        ) : (
          <p className="text-sm text-[var(--ink-muted)]">{t("coverSaveFirst")}</p>
        )}
      </section>

      {message && (
        <p
          role={message.error ? "alert" : "status"}
          className="p-4 border-2 border-[var(--ink)] bg-[var(--surface)] text-sm font-bold text-[var(--ink)]"
        >
          {message.text}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? t("saving") : t("save")}
        </Button>
        {campaignId && (
          <Button type="button" variant="primary" disabled={busy} onClick={() => run(submitForReview)}>
            {t("submit")}
          </Button>
        )}
      </div>
    </form>
  );
}

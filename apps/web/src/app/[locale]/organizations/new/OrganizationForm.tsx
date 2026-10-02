"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { Button, CheckboxGroup, Field, FileField, Textarea } from "@cherrio/ui";
import { LabeledSelect } from "@/components/LabeledSelect";
import { SearchableSelect } from "@/components/SearchableSelect";
import { focusFirstError } from "@/lib/forms/focus-first-error";
import {
  ORGANIZATION_CAUSES,
  ORGANIZATION_REGISTRIES,
  organizationApplicationSchema,
  type KybDocumentKind,
} from "@cherrio/shared/organizations";

export interface OrganizationFormValues {
  name: string;
  legalName: string;
  country: string;
  registry: string;
  registryId: string;
  website: string;
  description: string;
  causes: string[];
  payoutAddress: string;
}

const SLOTS: { key: string; kind: KybDocumentKind }[] = [
  { key: "extract", kind: "KYB_REGISTRATION_EXTRACT" },
  { key: "authorisation", kind: "KYB_AUTHORISATION" },
  { key: "statute", kind: "KYB_STATUTE" },
  { key: "other1", kind: "KYB_OTHER" },
  { key: "other2", kind: "KYB_OTHER" },
];
interface Slot {
  id?: string; // set once uploaded
  label?: string;
  error?: string;
}

export function OrganizationForm(props: {
  countries: { value: string; label: string }[];
  initial: OrganizationFormValues;
  /** Set for "Submit again": the rejected organisation; register and number are fixed. */
  organizationId?: string;
}) {
  const t = useTranslations("organizations.form");
  const tErrors = useTranslations("organizations.errors");
  const tFiles = useTranslations("files.errors");
  const router = useRouter();

  const [values, setValues] = React.useState(props.initial);
  const [slots, setSlots] = React.useState<Record<string, Slot>>({});
  const [invalid, setInvalid] = React.useState<string[]>([]);
  const formRef = React.useRef<HTMLFormElement>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const set = <K extends keyof OrganizationFormValues>(key: K, value: OrganizationFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));
  const setSlot = (key: string, slot: Slot) => setSlots((current) => ({ ...current, [key]: slot }));
  const fieldError = (field: string) => (invalid.includes(field) ? t(`fieldErrors.${field}` as never) : undefined);
  const text = (key: "name" | "legalName" | "registryId" | "website" | "payoutAddress") => ({
    label: t(key),
    value: values[key],
    error: fieldError(key),
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => set(key, event.target.value),
  });

  async function upload(key: string, kind: KybDocumentKind, file: File) {
    setSlot(key, { label: t("uploading") });
    const body = new FormData();
    body.set("kind", kind);
    body.set("file", file);
    try {
      const res = await fetch("/api/files/kyb", { method: "POST", body });
      const json = (await res.json()) as { id?: string; sizeBytes?: number; error?: string };
      if (res.ok && json.id) {
        setSlot(key, { id: json.id, label: t("uploaded", { size: Math.ceil((json.sizeBytes ?? 0) / 1024) }) });
      } else {
        const code = json.error ?? "";
        setSlot(key, { error: tFiles.has(code as never) ? tFiles(code as never) : t("uploadFailed") });
      }
    } catch {
      setSlot(key, { error: t("uploadFailed") });
    }
  }

  async function remove(key: string) {
    const id = slots[key]?.id;
    setSlot(key, {});
    // If this fails the file stays unattached and is removed automatically after 24 hours.
    if (id) await fetch(`/api/files/kyb/${id}`, { method: "DELETE" }).catch(() => undefined);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    const payload = {
      ...values,
      fileIds: SLOTS.flatMap(({ key }) => slots[key]?.id ?? []),
      organizationId: props.organizationId,
    };
    const parsed = organizationApplicationSchema.safeParse(payload);
    const problems = parsed.success ? [] : parsed.error.issues.map((issue) => String(issue.path[0]));
    // The schema reports this two-field rule only once every single field is valid.
    if (values.registry && values.registry !== "NONE" && !values.registryId.trim()) problems.push("registryId");
    const unique = [...new Set(problems)];
    setInvalid(unique);
    if (unique.length > 0) {
      setFormError(t("fixFields", { count: unique.length }));
      focusFirstError(formRef.current);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        router.push("/account/organization");
        router.refresh();
        return;
      }
      const json = (await res.json()) as { error?: string; fields?: string[] };
      if (json.fields) {
        setInvalid(json.fields);
        focusFirstError(formRef.current);
      }
      const code = json.error ?? "";
      setFormError(tErrors.has(code as never) ? tErrors(code as never) : t("submitFailed"));
    } catch {
      setFormError(t("submitFailed"));
    }
    setSubmitting(false);
  }

  const heading = "text-xl font-display uppercase text-[var(--ink)]";
  const note = "p-4 border-2 border-[var(--ink)] bg-[var(--surface)] text-sm font-bold text-[var(--ink)]";
  const card = "ch-panel p-6 md:p-8 flex flex-col gap-5";
  const locked = Boolean(props.organizationId);

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="flex flex-col gap-8">
      <section className={card}>
        <h2 className={heading}>{t("sectionAbout")}</h2>
        <Field {...text("name")} hint={t("nameHint")} maxLength={200} />
        <Field {...text("legalName")} hint={t("legalNameHint")} maxLength={200} />
        <SearchableSelect
          label={t("country")}
          placeholder={t("countryPlaceholder")}
          value={values.country}
          onChange={(value) => set("country", value)}
          options={props.countries}
          error={fieldError("country")}
          noMatch={t("countryNoMatch")}
        />
        <LabeledSelect
          label={t("registry")}
          placeholder={t("registryPlaceholder")}
          value={values.registry}
          onChange={(value) => set("registry", value)}
          options={ORGANIZATION_REGISTRIES.map((value) => ({ value, label: t(`registries.${value}`) }))}
          error={fieldError("registry")}
          hint={locked ? t("registryLocked") : undefined}
          disabled={locked}
        />
        <Field {...text("registryId")} hint={t("registryIdHint")} maxLength={64} disabled={locked} />
        <Field {...text("website")} hint={t("websiteHint")} type="url" inputMode="url" />
        <Textarea
          label={t("description")}
          hint={t("descriptionHint")}
          error={fieldError("description")}
          value={values.description}
          onChange={(event) => set("description", event.target.value)}
          maxLength={1000}
        />
        <CheckboxGroup
          label={t("causes")}
          hint={t("causesHint")}
          error={fieldError("causes")}
          options={ORGANIZATION_CAUSES.map((value) => ({ value, label: t(`causeNames.${value}`) }))}
          value={values.causes}
          onChange={(value) => set("causes", value)}
        />
      </section>

      <section className={card}>
        <h2 className={heading}>{t("sectionPayout")}</h2>
        <Field {...text("payoutAddress")} hint={t("payoutAddressHint")} mono autoComplete="off" spellCheck={false} />
        <p className={note}>{t("payoutNote")}</p>
      </section>

      <section className={card}>
        <h2 className={heading}>{t("sectionDocuments")}</h2>
        <p className={note}>{t("documentsNote")}</p>
        {SLOTS.map(({ key, kind }) => (
          <FileField
            key={key}
            label={t(`documents.${kind}`)}
            hint={t("documentsHint")}
            error={slots[key]?.error}
            accept=".pdf,.jpg,.jpeg,.png"
            fileLabel={slots[key]?.label}
            busy={Boolean(slots[key]?.label) && !slots[key]?.id}
            removeLabel={t("remove")}
            onSelect={(file) => upload(key, kind, file)}
            onRemove={() => remove(key)}
          />
        ))}
        {fieldError("fileIds") && (
          <p role="alert" className="ch-field-error">
            <span className="ch-field-hint">{fieldError("fileIds")}</span>
          </p>
        )}
      </section>

      {formError && (
        <p role="alert" className={note}>
          {formError}
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" size="lg" disabled={submitting}>
          {submitting ? t("submitting") : t("submit")}
        </Button>
      </div>
    </form>
  );
}

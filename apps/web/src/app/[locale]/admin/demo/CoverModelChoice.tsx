"use client";

import { useTranslations } from "next-intl";
import { DEMO_COVER_MODELS, type DemoCoverModel } from "@/lib/demo/cover-models";

/** Which fal.ai model draws the demo covers (TASK-043). */
export function CoverModelChoice({
  name,
  value,
  onChange,
  disabled = false,
}: {
  name: string;
  value: DemoCoverModel;
  onChange: (model: DemoCoverModel) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("admin.demo.coverModel");
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="ch-label">{t("legend")}</legend>
      {DEMO_COVER_MODELS.map((model) => (
        <label key={model} className="flex items-center gap-2 text-[var(--ink)]">
          <input type="radio" name={name} value={model} checked={value === model} onChange={() => onChange(model)} />
          {t(`models.${model}`)}
        </label>
      ))}
      <span className="text-sm text-[var(--ink-muted)]">{t("hint")}</span>
    </fieldset>
  );
}

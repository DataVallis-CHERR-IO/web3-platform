import { getTranslations, setRequestLocale } from "next-intl/server";
import { UnsubscribeButton } from "./UnsubscribeButton";

/** The "Stop these emails" link (TASK-033e). Opening it changes nothing; the button does. */
export default async function UnsubscribePage({
  params, searchParams,
}: { params: Promise<{ locale: string }>; searchParams: Promise<{ token?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const token = (await searchParams).token ?? "";
  const t = await getTranslations("notifications");
  return (
    <div className="ch-container py-12">
      <div className="max-w-xl mx-auto flex flex-col gap-4">
        <h1 className="ch-section-heading uppercase text-[var(--ink)]">{t("unsubscribeTitle")}</h1>
        <p className="text-base text-[var(--ink)]">{t("unsubscribeText")}</p>
        <UnsubscribeButton token={token} />
      </div>
    </div>
  );
}

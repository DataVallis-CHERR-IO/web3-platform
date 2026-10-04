import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";

/** Where the confirmation link lands (TASK-033e): `?ok=1` confirmed, otherwise expired or unknown. */
export default async function ConfirmedPage({
  params, searchParams,
}: { params: Promise<{ locale: string }>; searchParams: Promise<{ ok?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ok = (await searchParams).ok === "1";
  const t = await getTranslations("notifications");
  return (
    <div className="ch-container py-12">
      <div className="max-w-xl mx-auto flex flex-col gap-4">
        <h1 className="ch-section-heading uppercase text-[var(--ink)]">{ok ? t("confirmedTitle") : t("confirmFailedTitle")}</h1>
        <p className="text-base text-[var(--ink)]">{ok ? t("confirmedText") : t("confirmFailedText")}</p>
        <div>
          <Link href="/account/notifications" className="ch-btn no-underline">{t("toSettings")}</Link>
        </div>
      </div>
    </div>
  );
}

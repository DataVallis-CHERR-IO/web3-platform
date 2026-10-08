import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { Link } from "@/i18n/routing";
import { getNotificationSettings, pointBalances } from "@/lib/notifications/preferences";
import { NotificationSettingsForm } from "./NotificationSettingsForm";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "notifications" });
  return { title: t("metaTitle") };
}

/** Account → Email notifications (TASK-033e, ADR-048), with the vote points. */
export default async function NotificationSettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await getSession();
  if (!session) redirect(`/${locale}`);
  const db = getDb();
  const [settings, points, t] = await Promise.all([
    getNotificationSettings(db, session.userId),
    pointBalances(db, session.userId),
    getTranslations("notifications"),
  ]);
  return (
    <div className="ch-account-page">
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-2">
          <Link href="/account" className="text-sm font-bold underline text-[var(--ink)]">{t("back")}</Link>
          <h1 className="ch-section-heading uppercase text-[var(--ink)]">{t("title")}</h1>
          <p className="text-base text-[var(--ink-muted)]">{t("description")}</p>
        </div>
        <NotificationSettingsForm initial={settings} />
        <section className="ch-panel p-6 flex flex-col gap-2" aria-labelledby="points-title">
          <h2 id="points-title" className="text-xl font-display uppercase text-[var(--ink)]">{t("pointsTitle")}</h2>
          <p className="text-base font-bold text-[var(--ink)]">
            {t("pointsText", { status: points.status.toString(), reward: points.reward.toString(), votes: points.votes })}
          </p>
          <p className="text-sm text-[var(--ink-muted)]">{t("pointsHint")}</p>
        </section>
      </div>
    </div>
  );
}

import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { requireRole } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { loadGuardianQueue } from "@/lib/admin/guardian";
import { Link } from "@/i18n/routing";

/** Admin → Chain actions (TASK-033d) — PLATFORM_ADMIN only; 404 for everyone else. */
export default async function AdminGuardianPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  try {
    await requireRole("PLATFORM_ADMIN");
  } catch {
    notFound();
  }
  const t = await getTranslations("admin.guardian");
  const queue = await loadGuardianQueue(getDb());

  return (
    <div className="ch-container py-12 flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Link href="/admin" className="text-sm font-bold underline text-[var(--ink)]">
          {t("back")}
        </Link>
        <span className="ch-eyebrow">{t("eyebrow")}</span>
        <h1 className="ch-section-heading uppercase text-[var(--ink)]">{t("title")}</h1>
        <p className="text-[var(--ink)] max-w-3xl">{t("intro")}</p>
      </div>
      {queue === null ? (
        <p role="status" className="ch-panel p-5 font-bold text-[var(--ink)]">{t("unavailable")}</p>
      ) : queue.length === 0 ? (
        <p className="text-base text-[var(--ink)]">{t("empty")}</p>
      ) : (
        <div className="ch-ledger-wrap" tabIndex={0} role="region" aria-label={t("title")}>
          <table className="ch-ledger">
            <thead>
              <tr>
                <th>{t("colCampaign")}</th>
                <th>{t("colOrganisation")}</th>
                <th>{t("colState")}</th>
                <th>{t("colTask")}</th>
              </tr>
            </thead>
            <tbody>
              {queue.map((row) => (
                <tr key={row.id}>
                  <td className="whitespace-normal">
                    <Link href={`/admin/campaigns/${row.id}#chain-actions`} className="font-bold underline">
                      {row.title}
                    </Link>
                  </td>
                  <td className="whitespace-normal">{row.organization ?? "—"}</td>
                  <td className="whitespace-normal">{t(`states.${row.state}`)}</td>
                  <td className="whitespace-normal font-bold">{t(`tasks.${row.task}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

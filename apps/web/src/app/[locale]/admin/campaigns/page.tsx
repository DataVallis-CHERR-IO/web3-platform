import { notFound } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { asc, eq } from "drizzle-orm";
import { campaigns, organizations } from "@cherrio/db";
import { requireRole } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { Link } from "@/i18n/routing";

/** Campaign review queue — PLATFORM_ADMIN only; 404 for everyone else. Oldest submission first. */
export default async function CampaignQueuePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  try {
    await requireRole("PLATFORM_ADMIN");
  } catch {
    notFound();
  }

  const rows = await getDb()
    .select({
      id: campaigns.id,
      title: campaigns.title,
      targetEurCents: campaigns.targetEurCents,
      submittedAt: campaigns.submittedAt,
      organization: organizations.name,
    })
    .from(campaigns)
    .innerJoin(organizations, eq(organizations.id, campaigns.orgId))
    .where(eq(campaigns.status, "PENDING_REVIEW"))
    .orderBy(asc(campaigns.submittedAt));

  const t = await getTranslations("admin.campaigns");
  const format = await getFormatter();

  return (
    <div className="ch-container py-12 flex flex-col gap-6">
      <h1 className="text-3xl font-display uppercase tracking-tight text-[var(--ink)]">{t("queueTitle")}</h1>
      {rows.length === 0 ? (
        <p className="text-base text-[var(--ink)]">{t("queueEmpty")}</p>
      ) : (
        <div className="ch-ledger-wrap" tabIndex={0} role="region" aria-label={t("queueTitle")}>
          <table className="ch-ledger">
            <thead>
              <tr>
                <th>{t("colCampaign")}</th>
                <th>{t("colOrganisation")}</th>
                <th>{t("colTarget")}</th>
                <th>{t("colSubmitted")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={`/admin/campaigns/${row.id}`}>{row.title}</Link>
                  </td>
                  <td>{row.organization}</td>
                  <td>{t("eur", { amount: format.number(Number(BigInt(row.targetEurCents) / 100n)) })}</td>
                  <td>
                    {row.submittedAt ? format.dateTime(row.submittedAt, { dateStyle: "medium", timeStyle: "short" }) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

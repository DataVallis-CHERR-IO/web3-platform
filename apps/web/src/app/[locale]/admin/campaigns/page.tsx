import { notFound } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { asc, eq } from "drizzle-orm";
import { campaigns, organizations } from "@cherrio/db";
import { requireRole } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { Link } from "@/i18n/routing";

/**
 * Campaign review queue — PLATFORM_ADMIN only; 404 for everyone else.
 * Two lists: waiting for review (oldest submission first) and approved but
 * not yet published on Polygon (oldest approval first).
 */
export default async function CampaignQueuePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  try {
    await requireRole("PLATFORM_ADMIN");
  } catch {
    notFound();
  }

  const columns = {
    id: campaigns.id,
    title: campaigns.title,
    targetEurCents: campaigns.targetEurCents,
    submittedAt: campaigns.submittedAt,
    reviewedAt: campaigns.reviewedAt,
    publishTxHash: campaigns.publishTxHash,
    organization: organizations.name,
  };
  const [pending, approved] = await Promise.all([
    getDb()
      .select(columns)
      .from(campaigns)
      .innerJoin(organizations, eq(organizations.id, campaigns.orgId))
      .where(eq(campaigns.status, "PENDING_REVIEW"))
      .orderBy(asc(campaigns.submittedAt)),
    getDb()
      .select(columns)
      .from(campaigns)
      .innerJoin(organizations, eq(organizations.id, campaigns.orgId))
      .where(eq(campaigns.status, "APPROVED"))
      .orderBy(asc(campaigns.reviewedAt)),
  ]);

  const t = await getTranslations("admin.campaigns");
  const format = await getFormatter();
  const when = (date: Date | null) => (date ? format.dateTime(date, { dateStyle: "medium", timeStyle: "short" }) : "");
  const eur = (cents: string) => t("eur", { amount: format.number(Number(BigInt(cents) / 100n)) });

  return (
    <div className="ch-container py-12 flex flex-col gap-10">
      <section className="flex flex-col gap-6">
        <h1 className="text-3xl font-display uppercase tracking-tight text-[var(--ink)]">{t("queueTitle")}</h1>
        {pending.length === 0 ? (
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
                {pending.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link href={`/admin/campaigns/${row.id}`}>{row.title}</Link>
                    </td>
                    <td>{row.organization}</td>
                    <td>{eur(row.targetEurCents)}</td>
                    <td>{when(row.submittedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-6">
        <h2 className="text-2xl font-display uppercase tracking-tight text-[var(--ink)]">{t("approvedTitle")}</h2>
        {approved.length === 0 ? (
          <p className="text-base text-[var(--ink)]">{t("approvedEmpty")}</p>
        ) : (
          <div className="ch-ledger-wrap" tabIndex={0} role="region" aria-label={t("approvedTitle")}>
            <table className="ch-ledger">
              <thead>
                <tr>
                  <th>{t("colCampaign")}</th>
                  <th>{t("colOrganisation")}</th>
                  <th>{t("colTarget")}</th>
                  <th>{t("colApproved")}</th>
                  <th>{t("colPublish")}</th>
                </tr>
              </thead>
              <tbody>
                {approved.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link href={`/admin/campaigns/${row.id}`}>{row.title}</Link>
                    </td>
                    <td>{row.organization}</td>
                    <td>{eur(row.targetEurCents)}</td>
                    <td>{when(row.reviewedAt)}</td>
                    <td>{row.publishTxHash ? t("publishState.sent") : t("publishState.notSent")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

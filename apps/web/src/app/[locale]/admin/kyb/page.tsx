import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { asc, eq } from "drizzle-orm";
import { kybSubmissions, organizations } from "@cherrio/db";
import { requireRole } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { Link } from "@/i18n/routing";
import { LocalDateTime } from "@/components/LocalDateTime";

/** KYB review queue — PLATFORM_ADMIN only; 404 for everyone else (existence is hidden). */
export default async function KybQueuePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  try {
    await requireRole("PLATFORM_ADMIN");
  } catch {
    notFound();
  }

  const rows = await getDb()
    .select({
      id: kybSubmissions.id,
      createdAt: kybSubmissions.createdAt,
      application: kybSubmissions.application,
      name: organizations.name,
      country: organizations.country,
      registry: organizations.registry,
      registryId: organizations.registryId,
      source: organizations.source,
      claimedByUserId: organizations.claimedByUserId,
    })
    .from(kybSubmissions)
    .innerJoin(organizations, eq(organizations.id, kybSubmissions.orgId))
    .where(eq(kybSubmissions.status, "PENDING"))
    .orderBy(asc(kybSubmissions.createdAt));

  const t = await getTranslations("admin.kyb");
  const tRegistry = await getTranslations("organizations.form.registries");

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
                <th>{t("colOrganisation")}</th>
                <th>{t("colCountry")}</th>
                <th>{t("colRegister")}</th>
                <th>{t("colSubmitted")}</th>
                <th>{t("colType")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const submittedName = (row.application as { name?: string } | null)?.name;
                const claim = row.source === "IMPORTED" && row.claimedByUserId === null;
                return (
                  <tr key={row.id}>
                    <td>
                      <Link href={`/admin/kyb/${row.id}`}>{submittedName ?? row.name}</Link>
                    </td>
                    <td>{row.country}</td>
                    <td>
                      {row.registryId ? `${tRegistry(row.registry)} · ${row.registryId}` : t("noRegister")}
                    </td>
                    <td><LocalDateTime value={row.createdAt} /></td>
                    <td>{claim ? t("typeClaim") : t("typeNew")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

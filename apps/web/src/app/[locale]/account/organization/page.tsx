import { redirect } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { desc, eq } from "drizzle-orm";
import { kybSubmissions, organizations } from "@cherrio/db";
import { StatusChip, type Status } from "@cherrio/ui";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { Link } from "@/i18n/routing";

const CHIP: Record<"PENDING" | "APPROVED" | "REJECTED", Status> = {
  PENDING: "pending",
  APPROVED: "verified",
  REJECTED: "rejected",
};
const button = "ch-btn no-underline";

export default async function AccountOrganizationPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await getSession();
  if (!session) redirect(`/${locale}`);

  // The user's own applications, newest first; one card per organisation (its latest application).
  const rows = await getDb()
    .select({
      orgId: organizations.id,
      name: organizations.name,
      orgStatus: organizations.kybStatus,
      status: kybSubmissions.status,
      reviewNote: kybSubmissions.reviewNote,
      createdAt: kybSubmissions.createdAt,
    })
    .from(kybSubmissions)
    .innerJoin(organizations, eq(organizations.id, kybSubmissions.orgId))
    .where(eq(kybSubmissions.submittedBy, session.userId))
    .orderBy(desc(kybSubmissions.createdAt));
  const latest = rows.filter((row, index) => rows.findIndex((r) => r.orgId === row.orgId) === index);
  const hasPending = latest.some((row) => row.status === "PENDING");

  const t = await getTranslations("account.organization");
  const format = await getFormatter();

  return (
    <div className="ch-container py-12">
      <div className="max-w-3xl mx-auto flex flex-col gap-8">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl md:text-4xl font-display uppercase tracking-tight text-[var(--ink)]">
            {t("title")}
          </h1>
          <p className="text-base text-[var(--ink-muted)]">{t("description")}</p>
        </div>

        {latest.length === 0 && <p className="text-base text-[var(--ink)]">{t("empty")}</p>}
        {latest.map((row) => (
          <article key={row.orgId} className="ch-card p-6 md:p-8 flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-display uppercase text-[var(--ink)]">{row.name}</h2>
              <StatusChip status={CHIP[row.status]}>{t(`status.${row.status}`)}</StatusChip>
            </div>
            <p className="text-sm text-[var(--ink-muted)]">
              {t("submitted", { date: format.dateTime(row.createdAt, { dateStyle: "long" }) })}
            </p>
            {row.status === "PENDING" && <p className="text-sm text-[var(--ink)]">{t("pendingNote")}</p>}
            {row.status === "REJECTED" && row.reviewNote && (
              <div className="p-4 border-2 border-[var(--ink)] bg-[var(--surface)] flex flex-col gap-1">
                <span className="ch-label">{t("reviewNote")}</span>
                <p className="text-sm text-[var(--ink)] whitespace-pre-line">{row.reviewNote}</p>
              </div>
            )}
            {row.status === "REJECTED" && row.orgStatus === "REJECTED" && !hasPending && (
              <div>
                <Link href={`/organizations/new?organization=${row.orgId}`} className={button}>
                  {t("submitAgain")}
                </Link>
              </div>
            )}
          </article>
        ))}

        {!hasPending && (
          <div>
            <Link href="/organizations/new" className={`${button} ch-btn-primary`}>
              {t("register")}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

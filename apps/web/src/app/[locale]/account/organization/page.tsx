import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { StatusChip, type Status } from "@cherrio/ui";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { listOwnApplications } from "@/lib/organizations/own-applications";
import { Link } from "@/i18n/routing";
import { LocalDateTime } from "@/components/LocalDateTime";
import { and, eq } from "drizzle-orm";
import { orgMembers, organizations } from "@cherrio/db";
import { RatingList } from "@/components/ratings/RatingList";
import { RatingSummary } from "@/components/ratings/RatingSummary";
import { listRatings, orgRatingSummaries } from "@/lib/ratings";

const CHIP: Record<"PENDING" | "APPROVED" | "REJECTED", Status> = {
  PENDING: "in-review",
  APPROVED: "verified",
  REJECTED: "rejected",
};
const button = "ch-btn no-underline";

export default async function AccountOrganizationPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await getSession();
  if (!session) redirect(`/${locale}`);

  const db = getDb();
  const latest = await listOwnApplications(db, session.userId);
  // Ratings (TASK-057b): for every verified organisation the user is a member of.
  const memberOrgs = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
    .where(and(eq(orgMembers.userId, session.userId), eq(organizations.kybStatus, "APPROVED")));
  const rated = memberOrgs.map((o) => o.id);
  const [summaries, ratingLists] = await Promise.all([
    orgRatingSummaries(db, rated),
    Promise.all(rated.map(async (orgId) => [orgId, await listRatings(db, { orgId })] as const)),
  ]);
  const ratingsOf = new Map(ratingLists);
  const tRatings = await getTranslations("ratings");
  const hasPending = latest.some((row) => row.status === "PENDING");

  const t = await getTranslations("account.organization");

  return (
    <div className="ch-account-page">
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-2">
          <h1 className="ch-section-heading uppercase text-[var(--ink)]">
            {t("title")}
          </h1>
          <p className="text-base text-[var(--ink-muted)]">{t("description")}</p>
        </div>

        {latest.length === 0 && <p className="text-base text-[var(--ink)]">{t("empty")}</p>}
        {latest.map((row) => (
          <article key={row.orgId} className="ch-panel p-6 md:p-8 flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-display uppercase text-[var(--ink)]">{row.name}</h2>
              <StatusChip status={CHIP[row.status]}>{t(`status.${row.status}`)}</StatusChip>
            </div>
            <p className="text-sm text-[var(--ink-muted)]">
              {t("submittedOn")} <LocalDateTime value={row.createdAt} withTime={false} />
            </p>
            {row.status === "PENDING" && <p className="text-sm text-[var(--ink)]">{t("pendingNote")}</p>}
            {row.status === "REJECTED" && row.reviewNote && (
              <div className="p-4 border-2 border-[var(--ink)] bg-[var(--surface)] flex flex-col gap-1">
                <span className="ch-label">{t("reviewNote")}</span>
                <p className="text-sm text-[var(--ink)] whitespace-pre-line">{row.reviewNote}</p>
              </div>
            )}
            {row.canResubmit && (
              <div>
                <Link href={`/organizations/new?organization=${row.orgId}`} className={button}>
                  {t("submitAgain")}
                </Link>
              </div>
            )}
          </article>
        ))}

        {memberOrgs.map((o) => (
          <section key={o.id} className="ch-panel p-6 md:p-8 flex flex-col gap-3" aria-labelledby={`ratings-${o.id}`}>
            <div className="flex flex-wrap items-center gap-3">
              <h2 id={`ratings-${o.id}`} className="m-0 text-xl font-display uppercase text-[var(--ink)]">{tRatings("heading")}</h2>
              <RatingSummary summary={summaries.get(o.id)} locale={locale} />
            </div>
            <p className="m-0 text-sm font-bold text-[var(--ink)]">{o.name}</p>
            <p className="m-0 text-sm text-[var(--ink-muted)]">{tRatings("privateNote")}</p>
            <RatingList entries={ratingsOf.get(o.id) ?? []} />
          </section>
        ))}

        {latest.some((row) => row.status === "APPROVED") && (
          <div>
            <Link href="/account/campaigns" className={button}>
              {t("campaigns")}
            </Link>
          </div>
        )}

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

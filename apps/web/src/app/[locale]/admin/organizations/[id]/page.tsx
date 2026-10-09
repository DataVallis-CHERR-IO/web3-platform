import type * as React from "react";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { desc, eq } from "drizzle-orm";
import { campaigns, kybSubmissions, organizations, orgMembers, users } from "@cherrio/db";
import { checksumAddress } from "@cherrio/shared";
import { StatusChip } from "@cherrio/ui";
import { requireRole } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { SanctionedCountryNotice } from "@/components/admin/SanctionedCountryNotice";
import { isUuid } from "@/lib/files/storage";
import { Link } from "@/i18n/routing";
import { LocalDateTime } from "@/components/LocalDateTime";
import { RatingList } from "@/components/ratings/RatingList";
import { RatingSummary } from "@/components/ratings/RatingSummary";
import { listRatings, orgRatingSummaries } from "@/lib/ratings";
import { CAMPAIGN_CHIP } from "@/lib/campaigns/own";
import { KYB_CHIP } from "@/lib/admin/organizations";

const heading = "text-xl font-display uppercase text-[var(--ink)]";
const SUBMISSION_CHIP = { PENDING: "in-review", APPROVED: "verified", REJECTED: "rejected" } as const;

/** One organisation: data, members, KYB history, campaigns. PLATFORM_ADMIN only; 404 for everyone else. */
export default async function AdminOrganizationPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  try {
    await requireRole("PLATFORM_ADMIN");
  } catch {
    notFound();
  }
  if (!isUuid(id)) notFound();

  const db = getDb();
  const [organization] = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
  if (!organization) notFound();
  const [members, submissions, own] = await Promise.all([
    db
      .select({ id: users.id, displayName: users.displayName, email: users.email, role: orgMembers.role })
      .from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.userId))
      .where(eq(orgMembers.orgId, id)),
    db
      .select({ id: kybSubmissions.id, status: kybSubmissions.status, createdAt: kybSubmissions.createdAt })
      .from(kybSubmissions)
      .where(eq(kybSubmissions.orgId, id))
      .orderBy(desc(kybSubmissions.createdAt)),
    db
      .select({ id: campaigns.id, title: campaigns.title, status: campaigns.status, createdAt: campaigns.createdAt })
      .from(campaigns)
      .where(eq(campaigns.orgId, id))
      .orderBy(desc(campaigns.createdAt)),
  ]);

  const t = await getTranslations("admin.organizations");
  const tAudit = await getTranslations("admin.audit");
  const tRatings = await getTranslations("ratings");
  const [ratingSummary, ratingEntries] = await Promise.all([
    orgRatingSummaries(db, [organization.id]).then((m) => m.get(organization.id)),
    listRatings(db, { orgId: organization.id }),
  ]);
  const tKyb = await getTranslations("admin.organizations.kyb");
  const tSubmission = await getTranslations("admin.kyb.status");
  const tCampaign = await getTranslations("campaigns.status");
  const tCause = await getTranslations("organizations.form.causeNames");
  const tRegistry = await getTranslations("organizations.form.registries");
  const countries = new Intl.DisplayNames([locale], { type: "region" });
  const empty = "—";

  const data: [string, React.ReactNode][] = [
    [t("fields.legalName"), organization.legalName ?? empty],
    [t("fields.country"), countries.of(organization.country) ?? organization.country],
    [
      t("fields.registry"),
      organization.registryId ? `${tRegistry(organization.registry)} · ${organization.registryId}` : tRegistry(organization.registry),
    ],
    [t("fields.website"), organization.website ?? empty],
    [t("fields.causes"), organization.causes.map((c) => (tCause.has(c as never) ? tCause(c as never) : c)).join(", ") || empty],
    [t("fields.payoutAddress"), organization.payoutAddress ? checksumAddress(organization.payoutAddress) : empty],
    [t("fields.source"), t(`sources.${organization.source}`)],
    [t("fields.createdAt"), <LocalDateTime key="c" value={organization.createdAt} />],
  ];

  const table = (label: string, head: string[], rows: React.ReactNode[][]) => (
    <div className="ch-ledger-wrap" tabIndex={0} role="region" aria-label={label}>
      <table className="ch-ledger">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i}>
              {cells.map((cell, j) => (j === 0 && head.length === 2 ? <th key={j} scope="row">{cell}</th> : <td key={j} className="whitespace-normal break-words">{cell}</td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="ch-account-page flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <Link href="/admin/organizations" className="text-sm font-bold underline text-[var(--ink)]">
          {t("back")}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="ch-section-heading uppercase text-[var(--ink)] break-words">{organization.name}</h1>
          <StatusChip status={KYB_CHIP[organization.kybStatus]!}>{tKyb(organization.kybStatus)}</StatusChip>
        </div>
        <Link href={`/admin/audit?entity=${organization.id}`} className="text-sm font-bold underline text-[var(--ink)]">
          {tAudit("entityLink")}
        </Link>
      </div>

      <SanctionedCountryNotice codes={[organization.country]} locale={locale} />
      <section className="flex flex-col gap-3">
        <h2 className={heading}>{t("data")}</h2>
        {table(t("data"), [t("colField"), t("colValue")], data)}
        {organization.description && (
          <p className="text-base text-[var(--ink)] whitespace-pre-line max-w-3xl">{organization.description}</p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className={`${heading} m-0`}>{tRatings("adminHeading")}</h2>
          <RatingSummary summary={ratingSummary} locale={locale} />
        </div>
        <p className="m-0 text-sm text-[var(--ink-muted)]">{tRatings("adminNote")}</p>
        <RatingList entries={ratingEntries} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className={heading}>{t("members")}</h2>
        {members.length === 0 ? (
          <p className="text-base text-[var(--ink)]">{t("noMembers")}</p>
        ) : (
          table(
            t("members"),
            [t("colMember"), t("colEmail"), t("colRole")],
            members.map((m) => [m.displayName, m.email ?? empty, t(`roles.${m.role}`)])
          )
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className={heading}>{t("submissions")}</h2>
        {submissions.length === 0 ? (
          <p className="text-base text-[var(--ink)]">{t("noSubmissions")}</p>
        ) : (
          table(
            t("submissions"),
            [t("colSubmitted"), t("colStatus")],
            submissions.map((s) => [
              <Link key="l" href={`/admin/kyb/${s.id}`}>
                <LocalDateTime value={s.createdAt} />
              </Link>,
              <StatusChip key="s" status={SUBMISSION_CHIP[s.status]}>{tSubmission(s.status)}</StatusChip>,
            ])
          )
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className={heading}>{t("campaigns")}</h2>
        {own.length === 0 ? (
          <p className="text-base text-[var(--ink)]">{t("noCampaigns")}</p>
        ) : (
          table(
            t("campaigns"),
            [t("colCampaign"), t("colStatus"), t("colCreated")],
            own.map((c) => [
              <Link key="l" href={`/admin/campaigns/${c.id}`}>
                {c.title}
              </Link>,
              <StatusChip key="s" status={CAMPAIGN_CHIP[c.status]!}>{tCampaign(c.status)}</StatusChip>,
              <LocalDateTime key="d" value={c.createdAt} withTime={false} />,
            ])
          )
        )}
      </section>
    </div>
  );
}

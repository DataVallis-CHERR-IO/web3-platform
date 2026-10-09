import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { and, desc, eq } from "drizzle-orm";
import { campaignMedia, campaigns, organizations } from "@cherrio/db";
import { requireRole } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { Link } from "@/i18n/routing";
import { MAX_ACTIVE_CAMPAIGNS_PER_ORG } from "@cherrio/shared";
import { DEMO_BATCH_MAX, DEMO_NEW_ORGS_MAX, demoCampaignsAllowed } from "@/lib/demo/create";
import { DEMO_ORG_POOL } from "@/lib/demo/orgs";
import { DEMO_POOL } from "@/lib/demo/pool";
import { DemoForm } from "./DemoForm";
import { CoverGenerator } from "./CoverGenerator";
import { PublishAll } from "./PublishAll";

/** Admin → Demo campaigns (TASK-038a, ADR-052) — PLATFORM_ADMIN only, local/dev only; 404 otherwise. */
export default async function AdminDemoPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  if (!demoCampaignsAllowed()) notFound();
  try {
    await requireRole("PLATFORM_ADMIN");
  } catch {
    notFound();
  }
  const t = await getTranslations("admin.demo");
  const db = getDb();
  const [rows, demoOrgs] = await Promise.all([
    db
      .select({
        id: campaigns.id,
        slug: campaigns.slug,
        title: campaigns.title,
        status: campaigns.status,
        durationDays: campaigns.durationDays,
        deadline: campaigns.deadline,
        publishTxHash: campaigns.publishTxHash,
        coverCid: campaignMedia.cid,
        orgName: organizations.name,
      })
      .from(campaigns)
      .innerJoin(organizations, eq(organizations.id, campaigns.orgId))
      .leftJoin(campaignMedia, and(eq(campaignMedia.campaignId, campaigns.id), eq(campaignMedia.kind, "COVER")))
      .where(eq(campaigns.isDemo, true))
      .orderBy(desc(campaigns.createdAt))
      .limit(200),
    db
      .select({ payoutAddress: organizations.payoutAddress })
      .from(organizations)
      .where(eq(organizations.isDemo, true))
      .orderBy(desc(organizations.createdAt)),
  ]);
  const withoutCover = rows.filter((r) => r.coverCid === null).map((r) => r.id);

  return (
    <div className="ch-account-page flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Link href="/admin" className="text-sm font-bold underline text-[var(--ink)]">
          {t("back")}
        </Link>
        <span className="ch-eyebrow">{t("eyebrow")}</span>
        <h1 className="ch-section-heading uppercase text-[var(--ink)]">{t("title")}</h1>
        <p className="text-[var(--ink)] max-w-3xl">{t("intro", { max: DEMO_BATCH_MAX, pool: DEMO_POOL.length, orgPool: DEMO_ORG_POOL.length })}</p>
      </div>

      <DemoForm
        max={DEMO_BATCH_MAX}
        maxNewOrganizations={DEMO_NEW_ORGS_MAX}
        maxPerOrganization={MAX_ACTIVE_CAMPAIGNS_PER_ORG}
        existingOrganizations={demoOrgs.length}
        defaultPayout={demoOrgs[0]?.payoutAddress ?? ""}
      />

      <section className="flex flex-col gap-4" aria-labelledby="demo-list-heading">
        <h2 id="demo-list-heading" className="text-xl font-bold text-[var(--ink)]">
          {t("listTitle", { count: rows.length })}
        </h2>
        <CoverGenerator ids={withoutCover} />
        <PublishAll
          campaigns={rows
            .filter((r) => r.status === "APPROVED")
            .slice(0, DEMO_BATCH_MAX)
            .map((r) => ({ id: r.id, title: r.title, publishTxHash: r.publishTxHash }))}
        />
        {rows.length === 0 ? (
          <p className="text-base text-[var(--ink)]">{t("empty")}</p>
        ) : (
          <div className="ch-ledger-wrap" tabIndex={0} role="region" aria-labelledby="demo-list-heading">
            <table className="ch-ledger">
              <thead>
                <tr>
                  <th>{t("colCampaign")}</th>
                  <th>{t("colOrganisation")}</th>
                  <th>{t("colDuration")}</th>
                  <th>{t("colCover")}</th>
                  <th>{t("colStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/admin/campaigns/${r.id}`} className="underline font-bold text-[var(--ink)]">
                        {r.title}
                      </Link>
                    </td>
                    <td>{r.orgName}</td>
                    <td>{t("days", { count: r.durationDays })}</td>
                    <td>{r.coverCid ? t("coverYes") : t("coverNo")}</td>
                    <td>
                      {r.status === "DEPLOYED" ? (
                        <Link href={`/campaigns/${r.slug}`} className="underline text-[var(--ink)]">
                          {t("statusLive")}
                        </Link>
                      ) : r.status === "APPROVED" ? (
                        r.publishTxHash ? t("statusPublishing") : t("statusWaiting")
                      ) : r.status === "PENDING_REVIEW" ? (
                        <Link href={`/admin/campaigns/${r.id}`} className="underline text-[var(--ink)]">
                          {t("statusInReview")}
                        </Link>
                      ) : (
                        r.status
                      )}
                    </td>
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

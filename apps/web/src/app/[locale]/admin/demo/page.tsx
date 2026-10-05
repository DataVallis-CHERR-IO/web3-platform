import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { desc, eq } from "drizzle-orm";
import { campaigns, organizations } from "@cherrio/db";
import { requireRole } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { Link } from "@/i18n/routing";
import { DEMO_BATCH_MAX, DEMO_ORG_NAME, demoCampaignsAllowed } from "@/lib/demo/create";
import { DEMO_POOL } from "@/lib/demo/pool";
import { DemoForm } from "./DemoForm";

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
  const [rows, [org]] = await Promise.all([
    db
      .select({
        id: campaigns.id,
        slug: campaigns.slug,
        title: campaigns.title,
        status: campaigns.status,
        durationDays: campaigns.durationDays,
        deadline: campaigns.deadline,
        publishTxHash: campaigns.publishTxHash,
      })
      .from(campaigns)
      .where(eq(campaigns.isDemo, true))
      .orderBy(desc(campaigns.createdAt))
      .limit(200),
    db.select({ payoutAddress: organizations.payoutAddress }).from(organizations).where(eq(organizations.name, DEMO_ORG_NAME)).limit(1),
  ]);
  const waiting = rows.filter((r) => r.status === "APPROVED").length;

  return (
    <div className="ch-container py-12 flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Link href="/admin" className="text-sm font-bold underline text-[var(--ink)]">
          {t("back")}
        </Link>
        <span className="ch-eyebrow">{t("eyebrow")}</span>
        <h1 className="ch-section-heading uppercase text-[var(--ink)]">{t("title")}</h1>
        <p className="text-[var(--ink)] max-w-3xl">{t("intro", { max: DEMO_BATCH_MAX, pool: DEMO_POOL.length })}</p>
      </div>

      <DemoForm max={DEMO_BATCH_MAX} defaultPayout={org?.payoutAddress ?? ""} />

      <section className="flex flex-col gap-4" aria-labelledby="demo-list-heading">
        <h2 id="demo-list-heading" className="text-xl font-bold text-[var(--ink)]">
          {t("listTitle", { count: rows.length })}
        </h2>
        {waiting > 0 && <p className="text-[var(--ink)] max-w-3xl">{t("publishHint", { count: waiting })}</p>}
        {rows.length === 0 ? (
          <p className="text-base text-[var(--ink)]">{t("empty")}</p>
        ) : (
          <div className="ch-ledger-wrap" tabIndex={0} role="region" aria-labelledby="demo-list-heading">
            <table className="ch-ledger">
              <thead>
                <tr>
                  <th>{t("colCampaign")}</th>
                  <th>{t("colDuration")}</th>
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
                    <td>{t("days", { count: r.durationDays })}</td>
                    <td>
                      {r.status === "DEPLOYED" ? (
                        <Link href={`/campaigns/${r.slug}`} className="underline text-[var(--ink)]">
                          {t("statusLive")}
                        </Link>
                      ) : r.status === "APPROVED" ? (
                        r.publishTxHash ? t("statusPublishing") : t("statusWaiting")
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

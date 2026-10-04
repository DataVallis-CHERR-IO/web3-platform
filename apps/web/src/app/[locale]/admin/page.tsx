import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { count, eq } from "drizzle-orm";
import { campaigns, kybSubmissions, organizations } from "@cherrio/db";
import { requireRole } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { Link } from "@/i18n/routing";
import { loadGuardianQueue } from "@/lib/admin/guardian";

/** Admin home — PLATFORM_ADMIN only; 404 for everyone else (existence is hidden). Entry to every queue, with counts. */
export default async function AdminPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  let adminId: string;
  try {
    adminId = (await requireRole("PLATFORM_ADMIN")).userId;
  } catch {
    notFound();
  }

  const db = getDb();
  const countWhere = async (query: Promise<{ n: number }[]>) => (await query)[0]?.n ?? 0;
  const [kybPending, campaignsPending, campaignsApproved, campaignsLive, orgsVerified] = await Promise.all([
    countWhere(db.select({ n: count() }).from(kybSubmissions).where(eq(kybSubmissions.status, "PENDING"))),
    countWhere(db.select({ n: count() }).from(campaigns).where(eq(campaigns.status, "PENDING_REVIEW"))),
    countWhere(db.select({ n: count() }).from(campaigns).where(eq(campaigns.status, "APPROVED"))),
    countWhere(db.select({ n: count() }).from(campaigns).where(eq(campaigns.status, "DEPLOYED"))),
    countWhere(db.select({ n: count() }).from(organizations).where(eq(organizations.kybStatus, "APPROVED"))),
  ]);

  // null while the indexer views are missing (a deploy): the tile shows "—".
  const chainQueue = await loadGuardianQueue(db);

  const t = await getTranslations("admin");
  const tiles = [
    { href: "/admin/kyb", label: t("tiles.kybPending"), value: kybPending },
    { href: "/admin/campaigns", label: t("tiles.campaignsPending"), value: campaignsPending },
    { href: "/admin/campaigns?view=publish", label: t("tiles.campaignsApproved"), value: campaignsApproved },
    { href: "/admin/campaigns?view=live", label: t("tiles.campaignsLive"), value: campaignsLive },
    { href: "/admin/organizations?status=APPROVED", label: t("tiles.organizations"), value: orgsVerified },
    { href: "/admin/guardian", label: t("tiles.chainActions"), value: chainQueue === null ? "—" : chainQueue.length },
  ];

  return (
    <div className="ch-container py-12 flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <span className="ch-mono text-xs uppercase tracking-wider text-[var(--accent)] font-bold">{t("title")}</span>
        <h1 className="ch-section-heading uppercase text-[var(--ink)]">{t("overview")}</h1>
      </div>

      <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" aria-label={t("overview")}>
        {tiles.map((tile) => (
          <li key={tile.label} className="ch-panel p-5 flex flex-col gap-2">
            <span className="ch-label">{tile.label}</span>
            <span className="ch-mono text-3xl font-bold text-[var(--ink)]">{tile.value}</span>
            {tile.href && (
              <Link href={tile.href} className="text-sm font-bold underline text-[var(--ink)]">
                {t("tiles.open")}
                <span className="ch-sr-only">: {tile.label}</span>
              </Link>
            )}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-3">
        <Link href="/admin/kyb" className="ch-btn no-underline">
          {t("kybLink")}
        </Link>
        <Link href="/admin/campaigns" className="ch-btn no-underline">
          {t("campaignsLink")}
        </Link>
        <Link href="/admin/organizations" className="ch-btn no-underline">
          {t("organizationsLink")}
        </Link>
        <Link href="/admin/guardian" className="ch-btn no-underline">
          {t("guardianLink")}
        </Link>
        <Link href="/admin/contracts" className="ch-btn no-underline">
          {t("contractsLink")}
        </Link>
      </div>

      <p className="text-sm text-[var(--ink-muted)]">
        {t("adminIdLabel")}: <code className="ch-mono">{adminId}</code>
      </p>
    </div>
  );
}

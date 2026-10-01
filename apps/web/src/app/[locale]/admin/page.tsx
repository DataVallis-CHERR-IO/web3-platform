import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { useTranslations } from "next-intl";
import { requireRole } from "@/lib/auth/session";

export default async function AdminPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  let session;
  try {
    session = await requireRole("PLATFORM_ADMIN");
  } catch {
    // 404 for everyone else — do not reveal it exists
    notFound();
  }

  return <AdminView adminId={session.userId} />;
}

function AdminView({ adminId }: { adminId: string }) {
  const t = useTranslations("admin");

  return (
    <div className="ch-container py-16">
      <div className="ch-card p-8 md:p-12 max-w-2xl mx-auto flex flex-col gap-6 bg-[var(--surface-raised)]">
        <div className="flex flex-col gap-2">
          <span className="ch-mono text-xs uppercase tracking-wider text-[var(--accent)] font-bold">
            {t("title")}
          </span>
          <h1 className="text-2xl md:text-3xl font-display uppercase tracking-tight text-[var(--ink)]">
            {t("comingSoon")}
          </h1>
        </div>

        <div className="p-4 border-2 border-[var(--ink)] bg-[var(--surface)] flex flex-col gap-1">
          <span className="ch-label">{t("adminIdLabel")}</span>
          <code className="ch-mono text-sm break-all font-bold text-[var(--ink)]">
            {adminId}
          </code>
        </div>
      </div>
    </div>
  );
}

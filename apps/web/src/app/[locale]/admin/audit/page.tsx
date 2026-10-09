import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { eq } from "drizzle-orm";
import { users } from "@cherrio/db";
import { requireRole } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { Link } from "@/i18n/routing";
import { LocalDateTime } from "@/components/LocalDateTime";
import { ListFilters } from "@/components/admin/ListFilters";
import { decodeCursor, encodeCursor, listHref, type SearchParams } from "@/lib/admin/listing";
import { auditDataText, auditEntityHref, auditEntityTypes, auditFilters, listAuditLog } from "@/lib/admin/audit";

/**
 * Admin → Audit log (TASK-021): who did what and when, newest first, read-only.
 * PLATFORM_ADMIN with second factor only; 404 for everyone else.
 */
export default async function AdminAuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  try {
    await requireRole("PLATFORM_ADMIN");
  } catch {
    notFound();
  }

  const db = getDb();
  const query = await searchParams;
  const types = await auditEntityTypes(db);
  const filters = auditFilters(query, types);
  const cursor = decodeCursor(query);
  const [{ rows, next }, person] = await Promise.all([
    listAuditLog(db, filters, cursor),
    filters.actor && filters.actor !== "system"
      ? db.select({ name: users.displayName }).from(users).where(eq(users.id, filters.actor)).limit(1)
      : Promise.resolve([]),
  ]);

  const t = await getTranslations("admin.audit");
  const tList = await getTranslations("admin.list");
  const path = "/admin/audit";
  const personName = person[0]?.name || filters.actor;

  return (
    <div className="ch-account-page flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="ch-section-heading uppercase text-[var(--ink)]">{t("title")}</h1>
        <p className="text-base text-[var(--ink-muted)]">{t("intro")}</p>
      </div>

      <Suspense>
        <ListFilters
          searchLabel={t("search")}
          searchHint={t("searchHint")}
          selects={[
            {
              key: "type",
              label: t("type"),
              value: filters.type || "all",
              options: [{ value: "all", label: tList("any") }, ...types.map((type) => ({ value: type, label: type }))],
            },
            {
              key: "actor",
              label: t("actor"),
              value: filters.actor === "system" ? "system" : "all",
              options: [
                { value: "all", label: t("anyone") },
                { value: "system", label: t("system") },
              ],
            },
          ]}
        />
      </Suspense>

      {(filters.entity || (filters.actor && filters.actor !== "system")) && (
        <ul className="flex flex-col gap-2" aria-label={t("activeFilters")}>
          {filters.actor && filters.actor !== "system" && (
            <li className="text-sm text-[var(--ink)]">
              {t("onlyPerson", { name: personName })}{" "}
              <Link href={listHref(path, query, { actor: null })} className="font-bold underline">
                {t("clear")}
              </Link>
            </li>
          )}
          {filters.entity && (
            <li className="text-sm text-[var(--ink)]">
              {t("onlyEntity")} <code className="ch-mono">{filters.entity}</code>{" "}
              <Link href={listHref(path, query, { entity: null })} className="font-bold underline">
                {t("clear")}
              </Link>
            </li>
          )}
        </ul>
      )}

      {rows.length === 0 ? (
        <p className="text-base text-[var(--ink)]">{tList("empty")}</p>
      ) : (
        <div className="ch-ledger-wrap" tabIndex={0} role="region" aria-label={t("title")}>
          <table className="ch-ledger">
            <thead>
              <tr>
                <th>{t("colTime")}</th>
                <th>{t("colWho")}</th>
                <th>{t("colAction")}</th>
                <th>{t("colSubject")}</th>
                <th>{t("colDetails")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const entityHref = auditEntityHref(row.entityType, row.entityId);
                const details = auditDataText(row.data);
                return (
                  <tr key={row.id}>
                    <td>
                      <LocalDateTime value={row.createdAt} />
                    </td>
                    <td className="whitespace-normal">
                      {row.actorUserId ? (
                        <Link href={listHref(path, query, { actor: row.actorUserId })}>
                          {row.actorName || t("unnamed")}
                        </Link>
                      ) : (
                        <span className="text-[var(--ink-muted)]">{t("system")}</span>
                      )}
                    </td>
                    <td className="ch-mono">{row.action}</td>
                    <td className="whitespace-normal">
                      <span className="block">{row.entityType}</span>
                      {row.entityId && (
                        <span className="block text-xs">
                          {entityHref ? (
                            <Link href={entityHref} className="ch-mono">{row.entityId.slice(0, 8)}</Link>
                          ) : (
                            <span className="ch-mono">{row.entityId.slice(0, 8)}</span>
                          )}{" "}
                          <Link href={listHref(path, query, { entity: row.entityId })} className="underline">
                            {t("history")}
                          </Link>
                        </span>
                      )}
                    </td>
                    <td className="whitespace-normal">
                      {details ? <code className="ch-mono text-xs ch-audit-data">{details}</code> : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <nav aria-label={tList("pages")} className="flex flex-wrap gap-3">
        {cursor && (
          <Link href={listHref(path, query, {})} className="ch-btn ch-btn-ghost no-underline">
            {tList("firstPage")}
          </Link>
        )}
        {next && (
          <Link href={listHref(path, query, { after: encodeCursor(next) })} className="ch-btn no-underline">
            {tList("nextPage")}
          </Link>
        )}
      </nav>
    </div>
  );
}

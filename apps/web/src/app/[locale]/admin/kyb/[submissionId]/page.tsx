import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { kybSubmissions, organizations, privateFiles, users } from "@cherrio/db";
import { checksumAddress, type OrganizationApplicationData } from "@cherrio/shared";
import { StatusChip, type Status } from "@cherrio/ui";
import { requireRole } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/files/storage";
import { Link } from "@/i18n/routing";
import { ReviewActions } from "./ReviewActions";
import { LocalDateTime } from "@/components/LocalDateTime";

const CHIP: Record<"PENDING" | "APPROVED" | "REJECTED", Status> = {
  PENDING: "pending",
  APPROVED: "verified",
  REJECTED: "rejected",
};
const FIELDS = ["name", "legalName", "country", "website", "description", "causes", "payoutAddress"] as const;
const heading = "text-xl font-display uppercase text-[var(--ink)]";

/** One KYB application for review — PLATFORM_ADMIN only; 404 for everyone else. */
export default async function KybSubmissionPage({
  params,
}: {
  params: Promise<{ locale: string; submissionId: string }>;
}) {
  const { locale, submissionId } = await params;
  setRequestLocale(locale);
  try {
    await requireRole("PLATFORM_ADMIN");
  } catch {
    notFound();
  }
  if (!isUuid(submissionId)) notFound();

  const db = getDb();
  const [row] = await db
    .select({ submission: kybSubmissions, organization: organizations, applicant: users })
    .from(kybSubmissions)
    .innerJoin(organizations, eq(organizations.id, kybSubmissions.orgId))
    .innerJoin(users, eq(users.id, kybSubmissions.submittedBy))
    .where(eq(kybSubmissions.id, submissionId))
    .limit(1);
  if (!row) notFound();
  const { submission, organization, applicant } = row;

  const files = await db
    .select({ id: privateFiles.id, kind: privateFiles.kind, sizeBytes: privateFiles.sizeBytes, sha256: privateFiles.sha256 })
    .from(privateFiles)
    .where(and(eq(privateFiles.kybSubmissionId, submission.id), isNull(privateFiles.deletedAt)));
  const earlier = await db
    .select()
    .from(kybSubmissions)
    .where(and(eq(kybSubmissions.orgId, organization.id), ne(kybSubmissions.id, submission.id)))
    .orderBy(desc(kybSubmissions.createdAt));

  const t = await getTranslations("admin.kyb");
  const proposed = (submission.application ?? {}) as Partial<OrganizationApplicationData>;
  const display = (source: Partial<Record<(typeof FIELDS)[number], unknown>>, field: (typeof FIELDS)[number]) => {
    const value = source[field];
    if (Array.isArray(value)) return value.join(", ") || t("empty");
    if (typeof value !== "string" || value === "") return t("empty");
    return field === "payoutAddress" ? checksumAddress(value) : value;
  };
  // A claim or a resubmission: the row on CHERR.IO differs from what was submitted until approval.
  const pending = submission.status === "PENDING";
  const showCurrent = pending && FIELDS.some((field) => display(organization, field) !== display(proposed, field));
  const payoutAddress = display(proposed, "payoutAddress");

  return (
    <div className="ch-container py-12 flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <Link href="/admin/kyb" className="text-sm font-bold underline text-[var(--ink)]">
          {t("back")}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-display uppercase tracking-tight text-[var(--ink)]">
            {t("detailTitle", { name: proposed.name ?? organization.name })}
          </h1>
          <StatusChip status={CHIP[submission.status]}>{t(`status.${submission.status}`)}</StatusChip>
        </div>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className={heading}>{t("applicant")}</h2>
        <p className="text-base text-[var(--ink)]">
          {t("applicantName")}: {applicant.displayName} · {t("applicantEmail")}: {applicant.email ?? t("noEmail")}
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className={heading}>{t("data")}</h2>
        {showCurrent && <p className="text-sm font-bold text-[var(--ink)]">{t("approvalChanges")}</p>}
        <div className="ch-ledger-wrap" tabIndex={0} role="region" aria-label={t("data")}>
          <table className="ch-ledger">
            <thead>
              <tr>
                <th>{t("colField")}</th>
                {showCurrent && <th>{t("colCurrent")}</th>}
                <th>{t("colProposed")}</th>
              </tr>
            </thead>
            <tbody>
              {FIELDS.map((field) => (
                <tr key={field}>
                  <th scope="row">{t(`fields.${field}`)}</th>
                  {showCurrent && <td className="whitespace-normal">{display(organization, field)}</td>}
                  <td className="whitespace-normal">{display(proposed, field)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className={heading}>{t("documents")}</h2>
        <div className="ch-ledger-wrap" tabIndex={0} role="region" aria-label={t("documents")}>
          <table className="ch-ledger">
            <thead>
              <tr>
                <th>{t("colDocument")}</th>
                <th>{t("colSize")}</th>
                <th>{t("colHash")}</th>
                <th>{t("download")}</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr key={file.id}>
                  <td>{t(`kinds.${file.kind}`)}</td>
                  <td>{t("sizeKb", { size: Math.ceil(file.sizeBytes / 1024) })}</td>
                  <td>{file.sha256.slice(0, 12)}…</td>
                  <td>
                    <a href={`/api/admin/files/${file.id}`} download>
                      {t("download")}: {t(`kinds.${file.kind}`)}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {earlier.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className={heading}>{t("history")}</h2>
          {earlier.map((item) => (
            <div key={item.id} className="p-4 border-2 border-[var(--ink)] bg-[var(--surface)] flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-3">
                <StatusChip status={CHIP[item.status]}>{t(`status.${item.status}`)}</StatusChip>
                <span className="text-sm text-[var(--ink-muted)]">
                  <LocalDateTime value={item.createdAt} withTime={false} />
                </span>
              </div>
              {item.reviewNote && <p className="text-sm text-[var(--ink)] whitespace-pre-line">{item.reviewNote}</p>}
            </div>
          ))}
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className={heading}>{t("decision")}</h2>
        {pending ? (
          <ReviewActions submissionId={submission.id} payoutAddress={payoutAddress} />
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-base text-[var(--ink)]">{t("decided")}</p>
            {submission.reviewNote && (
              <p className="text-sm text-[var(--ink)] whitespace-pre-line">
                {t("note")}: {submission.reviewNote}
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

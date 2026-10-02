import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { and, desc, eq } from "drizzle-orm";
import { kybSubmissions, organizations, orgMembers } from "@cherrio/db";
import { COUNTRY_CODES, type OrganizationApplicationData } from "@cherrio/shared";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { OrganizationForm, type OrganizationFormValues } from "./OrganizationForm";

const EMPTY: OrganizationFormValues = {
  name: "", legalName: "", country: "", registry: "", registryId: "",
  website: "", description: "", causes: [], payoutAddress: "",
};

/** "Submit again": the user's rejected organisation, prefilled from their last application. */
async function loadRejected(userId: string, organizationId: string): Promise<OrganizationFormValues | null> {
  if (!/^[0-9a-f-]{36}$/.test(organizationId)) return null;
  const db = getDb();
  const [org] = await db
    .select({ registry: organizations.registry, registryId: organizations.registryId })
    .from(organizations)
    .innerJoin(orgMembers, eq(orgMembers.orgId, organizations.id))
    .where(
      and(
        eq(organizations.id, organizationId),
        eq(organizations.kybStatus, "REJECTED"),
        eq(orgMembers.userId, userId),
        eq(orgMembers.role, "ORG_ADMIN")
      )
    )
    .limit(1);
  if (!org) return null;
  const [last] = await db
    .select({ application: kybSubmissions.application })
    .from(kybSubmissions)
    .where(and(eq(kybSubmissions.orgId, organizationId), eq(kybSubmissions.submittedBy, userId)))
    .orderBy(desc(kybSubmissions.createdAt))
    .limit(1);
  const data = (last?.application ?? {}) as Partial<OrganizationApplicationData>;
  return {
    ...EMPTY,
    ...data,
    website: data.website ?? "",
    registry: org.registry,
    registryId: org.registryId ?? "",
  };
}

export default async function NewOrganizationPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ organization?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await getSession();
  if (!session) redirect(`/${locale}`);

  const { organization } = await searchParams;
  const rejected = organization ? await loadRejected(session.userId, organization) : null;
  if (organization && !rejected) redirect(`/${locale}/account/organization`);

  const t = await getTranslations("organizations.form");
  const names = new Intl.DisplayNames([locale], { type: "region" });
  const countries = COUNTRY_CODES.map((value) => ({ value, label: names.of(value) ?? value })).sort((a, b) =>
    a.label.localeCompare(b.label, locale)
  );

  return (
    <div className="ch-container py-12">
      <div className="max-w-3xl mx-auto flex flex-col gap-8">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl md:text-4xl font-display uppercase tracking-tight text-[var(--ink)]">
            {rejected ? t("titleAgain") : t("title")}
          </h1>
          <p className="text-base text-[var(--ink-muted)]">{t("intro")}</p>
        </div>
        <OrganizationForm
          countries={countries}
          initial={rejected ?? EMPTY}
          organizationId={rejected ? organization : undefined}
        />
      </div>
    </div>
  );
}

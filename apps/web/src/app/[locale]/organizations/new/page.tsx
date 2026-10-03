import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { COUNTRY_CODES, type OrganizationApplicationData } from "@cherrio/shared";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { listOwnApplications } from "@/lib/organizations/own-applications";
import { OrganizationForm, type OrganizationFormValues } from "./OrganizationForm";

const EMPTY: OrganizationFormValues = {
  name: "", legalName: "", country: "", registry: "", registryId: "",
  website: "", description: "", causes: [], payoutAddress: "",
};

/** "Submit again": prefilled from the user's last, rejected application for this organisation. */
async function loadRejected(userId: string, organizationId: string): Promise<OrganizationFormValues | null> {
  const own = (await listOwnApplications(getDb(), userId)).find((row) => row.orgId === organizationId);
  if (!own?.canResubmit) return null;
  const data = (own.application ?? {}) as Partial<OrganizationApplicationData>;
  return {
    ...EMPTY,
    ...data,
    website: data.website ?? "",
    registry: own.registry,
    registryId: own.registryId ?? "",
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
          <h1 className="ch-section-heading uppercase text-[var(--ink)]">
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

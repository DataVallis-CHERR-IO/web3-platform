import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ALLOWED_COUNTRY_CODES, type OrganizationApplicationData } from "@cherrio/shared";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { listOwnApplications } from "@/lib/organizations/own-applications";
import { getClaimableOrganization } from "@/lib/market-cap/profile";
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

/** "Claim this organization" (TASK-017c): an unclaimed imported organisation, prefilled from its register. */
async function loadClaim(organizationId: string): Promise<OrganizationFormValues | null> {
  const org = await getClaimableOrganization(getDb(), organizationId);
  if (!org) return null;
  return {
    ...EMPTY,
    name: org.name,
    legalName: org.name,
    country: org.country,
    registry: org.registry,
    registryId: org.registry_id ?? "",
    // The form takes only https links; an http one from the register is left for the claimant.
    website: org.website?.startsWith("https://") ? org.website : "",
    description: org.description ?? "",
    causes: org.causes,
  };
}

export default async function NewOrganizationPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ organization?: string; claim?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { organization, claim } = await searchParams;
  const session = await getSession();
  if (!session) redirect(claim ? `/${locale}/charity-market-cap/${encodeURIComponent(claim)}` : `/${locale}`);

  const rejected = organization ? await loadRejected(session.userId, organization) : null;
  if (organization && !rejected) redirect(`/${locale}/account/organization`);
  const claimed = !organization && claim ? await loadClaim(claim) : null;
  if (claim && !organization && !claimed) redirect(`/${locale}/charity-market-cap/${encodeURIComponent(claim)}`);

  const t = await getTranslations("organizations.form");
  const names = new Intl.DisplayNames([locale], { type: "region" });
  const countries = ALLOWED_COUNTRY_CODES.map((value) => ({ value, label: names.of(value) ?? value })).sort((a, b) =>
    a.label.localeCompare(b.label, locale)
  );

  return (
    <div className="ch-container py-12">
      <div className="max-w-3xl mx-auto flex flex-col gap-8">
        <div className="flex flex-col gap-2">
          <h1 className="ch-section-heading uppercase text-[var(--ink)]">
            {rejected ? t("titleAgain") : claimed ? t("titleClaim", { name: claimed.name }) : t("title")}
          </h1>
          <p className="text-base text-[var(--ink-muted)]">{claimed ? t("introClaim") : t("intro")}</p>
        </div>
        <OrganizationForm
          countries={countries}
          initial={rejected ?? claimed ?? EMPTY}
          organizationId={rejected ? organization : claimed ? claim : undefined}
          claim={Boolean(claimed)}
        />
      </div>
    </div>
  );
}

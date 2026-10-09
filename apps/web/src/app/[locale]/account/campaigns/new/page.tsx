import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { countryOptions, listCampaignOrganizations } from "@/lib/campaigns/own";
import { CampaignForm } from "../CampaignForm";

export default async function NewCampaignPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await getSession();
  if (!session) redirect(`/${locale}`);

  // Only an approved organisation can start a campaign.
  const organizations = await listCampaignOrganizations(getDb(), session.userId);
  if (organizations.length === 0) redirect(`/${locale}/account/campaigns`);
  const t = await getTranslations("campaigns");

  return (
    <div className="ch-account-page">
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-2">
          <h1 className="ch-section-heading uppercase text-[var(--ink)]">
            {t("newTitle")}
          </h1>
          <p className="text-base text-[var(--ink-muted)]">{t("intro")}</p>
        </div>
        <CampaignForm
          organizations={organizations.map((org) => ({ value: org.id, label: org.name }))}
          countries={countryOptions(locale)}
          initial={{
            organizationId: organizations.length === 1 ? organizations[0]!.id : "",
            title: "", story: "", cause: "", country: "", goalCurrency: "EUR", goal: "", durationDays: "30",
          }}
        />
      </div>
    </div>
  );
}

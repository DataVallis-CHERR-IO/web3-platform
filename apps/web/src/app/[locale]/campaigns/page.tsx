import { setRequestLocale } from "next-intl/server";
import { ComingSoon } from "@/components/ComingSoon";

export default async function CampaignsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <ComingSoon titleKey="campaignsTitle" descKey="campaignsDesc" />;
}

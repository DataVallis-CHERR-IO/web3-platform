import { setRequestLocale } from "next-intl/server";
import { ComingSoon } from "@/components/ComingSoon";

export default async function CharityMarketCapPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <ComingSoon titleKey="cmcTitle" descKey="cmcDesc" />;
}

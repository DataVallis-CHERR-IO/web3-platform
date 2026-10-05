import { getTranslations } from "next-intl/server";
import { isSanctionedCountry } from "@cherrio/shared";

/**
 * Admin pages (KYB, organisation, campaign): a warning when a country on the
 * record is under EU/US/UN sanctions (ADR-054). Approval is refused on the
 * server too; this only says why before the admin tries.
 */
export async function SanctionedCountryNotice({ codes, locale }: { codes: (string | null | undefined)[]; locale: string }) {
  const hit = codes.find((code): code is string => typeof code === "string" && isSanctionedCountry(code));
  if (!hit) return null;
  const t = await getTranslations("admin");
  const name = new Intl.DisplayNames([locale], { type: "region" }).of(hit.toUpperCase()) ?? hit;
  return (
    <p role="alert" className="ch-notice m-0 font-bold">
      {t("sanctionedCountry", { country: name })}
    </p>
  );
}

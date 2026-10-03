import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

// Licences and third-party notices (ADR-044). The Reown and MetaMask SDKs come
// in through Privy; their licences require these notices in the operated
// service. Full list: THIRD_PARTY_NOTICES.md in the repository.

const REPO = "https://github.com/DataVallis-CHERR-IO/web3-platform/blob/dev";
const NOTICES = [
  { key: "reown", licence: "https://raw.githubusercontent.com/reown-com/appkit/main/LICENSE.md" },
  { key: "walletconnect", licence: "https://raw.githubusercontent.com/WalletConnect/walletconnect-monorepo/v2.0/LICENSE.md" },
  { key: "metamask", licence: "https://raw.githubusercontent.com/MetaMask/metamask-sdk/main/LICENSE" },
  { key: "fonts", licence: "https://openfontlicense.org/open-font-license-official-text/" },
] as const;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "licences" });
  return { title: t("metaTitle") };
}

export default async function LicencesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("licences");

  return (
    <div className="ch-campaigns">
      <header className="flex flex-col gap-4">
        <span className="ch-eyebrow">{t("eyebrow")}</span>
        <h1 className="ch-section-heading">{t("title")}</h1>
      </header>

      <section className="flex max-w-[65ch] flex-col gap-3" aria-labelledby="own-code">
        <h2 className="heading-2 m-0" id="own-code">
          {t("ownTitle")}
        </h2>
        <p className="m-0">{t("ownBody")}</p>
        <p className="m-0">{t("brandBody")}</p>
        <p className="m-0 flex flex-wrap gap-4">
          <a className="ch-proof" href={`${REPO}/LICENSE`} target="_blank" rel="noopener noreferrer">
            {t("licenceLink")}
          </a>
          <a className="ch-proof" href={`${REPO}/TRADEMARKS.md`} target="_blank" rel="noopener noreferrer">
            {t("trademarksLink")}
          </a>
        </p>
      </section>

      <section className="flex max-w-[65ch] flex-col gap-3" aria-labelledby="third-party">
        <h2 className="heading-2 m-0" id="third-party">
          {t("thirdPartyTitle")}
        </h2>
        <p className="m-0">{t("thirdPartyBody")}</p>
        <ul className="ch-campaign-docs">
          {NOTICES.map((n) => (
            <li key={n.key} className="ch-panel flex flex-col gap-2 p-4">
              <strong>{t(`notices.${n.key}.name`)}</strong>
              <span>{t(`notices.${n.key}.notice`)}</span>
              <a className="ch-proof" href={n.licence} target="_blank" rel="noopener noreferrer">
                {t("licenceText", { name: t(`notices.${n.key}.name`) })}
              </a>
            </li>
          ))}
        </ul>
        <p className="m-0">
          <a className="ch-proof" href={`${REPO}/THIRD_PARTY_NOTICES.md`} target="_blank" rel="noopener noreferrer">
            {t("allNotices")}
          </a>
        </p>
      </section>
    </div>
  );
}

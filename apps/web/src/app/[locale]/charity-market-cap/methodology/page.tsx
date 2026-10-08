import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { COMPLETENESS_CHECKS, TRUST_COMPONENTS, TRUST_SCORE_VERSION } from "@cherrio/shared/trust";
import { Link } from "@/i18n/routing";

// TASK-017b (ADR-059): the published method of Trust Score v1. The weights and
// checks listed here are the shared constants the worker computes with.

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "marketCap.methodology" });
  return { title: t("metaTitle") };
}

export default async function MethodologyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("marketCap.methodology");

  return (
    <article className="ch-container py-12 flex flex-col gap-8 max-w-[80ch]">
      <header className="flex flex-col gap-4">
        <h1 className="ch-section-heading">{t("title")}</h1>
        <p className="m-0 text-lg leading-7">{t("intro", { version: TRUST_SCORE_VERSION })}</p>
      </header>

      <section className="flex flex-col gap-4" aria-labelledby="m-registered">
        <h2 id="m-registered" className="m-0 text-2xl font-bold">{t("registeredTitle")}</h2>
        <p className="m-0">{t("registeredIntro")}</p>
        <dl className="m-0 flex flex-col gap-4">
          {TRUST_COMPONENTS.map((key) => (
            <div key={key} className="ch-panel p-4 flex flex-col gap-1">
              <dt className="font-bold">
                {t(`components.${key}.name`)} · <span className="ch-mono">{t(`components.${key}.weight`)}</span>
              </dt>
              <dd className="m-0">{t(`components.${key}.body`)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="m-imported">
        <h2 id="m-imported" className="m-0 text-2xl font-bold">{t("importedTitle")}</h2>
        <p className="m-0">{t("importedBody")}</p>
        <ul className="m-0 pl-6 list-disc flex flex-col gap-1">
          {COMPLETENESS_CHECKS.map((key) => (
            <li key={key}>{t(`checks.${key}`)}</li>
          ))}
        </ul>
        <p className="m-0">{t("importedNote")}</p>
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="m-updates">
        <h2 id="m-updates" className="m-0 text-2xl font-bold">{t("updatesTitle")}</h2>
        <p className="m-0">{t("updatesBody")}</p>
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="m-not-listed">
        <h2 id="m-not-listed" className="m-0 text-2xl font-bold">{t("notListedTitle")}</h2>
        <p className="m-0">{t("notListedBody")}</p>
      </section>

      <Link href="/charity-market-cap" className="ch-proof self-start">
        {t("back")}
      </Link>
    </article>
  );
}

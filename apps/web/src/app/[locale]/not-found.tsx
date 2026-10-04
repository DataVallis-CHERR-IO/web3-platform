import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/routing";

/** The one 404 page under a locale: unknown URLs and the admin area for non-admins (TASK-035). */
export default async function NotFound() {
  const t = await getTranslations("notFoundPage");
  return (
    <div className="ch-campaigns">
      <header className="flex flex-col gap-4">
        <span className="ch-eyebrow">404</span>
        <h1 className="ch-section-heading">{t("title")}</h1>
      </header>
      <p className="m-0 max-w-[65ch]">{t("body")}</p>
      <p className="m-0">
        <Link className="ch-proof" href="/">
          {t("home")}
        </Link>
      </p>
    </div>
  );
}

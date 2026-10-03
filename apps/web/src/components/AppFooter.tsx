/**
 * AppFooter — ink background, white wordmark, Data Vallis credit, ThemeToggle.
 * All strings via next-intl.
 */
import Image from "next/image";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import { ThemeToggle } from "./ThemeToggle";

export function AppFooter() {
  const tNav = useTranslations("ui.nav");
  const tFooter = useTranslations("ui.footer");

  return (
    <footer className="ch-footer">
      <div className="ch-footer-top">
        {/* White wordmark on ink bg */}
        <Image
          src="/brand/cherrio-wordmark-white.svg"
          alt={tNav("logoAlt")}
          width={120}
          height={34}
        />
        <nav className="ch-footer-links" aria-label={tNav("footerNav")}>
          <Link href="/about" className="ch-footer-link">{tNav("about")}</Link>
          <Link href="/docs" className="ch-footer-link">{tNav("docs")}</Link>
          <Link href="/campaigns" className="ch-footer-link">{tNav("campaigns")}</Link>
          <Link href="/licences" className="ch-footer-link">{tNav("licences")}</Link>
        </nav>
      </div>
      <div className="ch-footer-bottom">
        <span className="ch-footer-credit">
          © {new Date().getFullYear()} CHERR.IO · {tFooter("operatedBy")}
          <br />
          {tFooter("rates")}
        </span>
        <ThemeToggle />
      </div>
    </footer>
  );
}

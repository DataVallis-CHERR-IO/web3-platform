/**
 * AppFooter — ink background, white wordmark, Data Vallis credit, ThemeToggle.
 * All strings via next-intl.
 */
import Image from "next/image";
import { useTranslations } from "next-intl";
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
          <a href="/about" className="ch-footer-link">{tNav("about")}</a>
          <a href="/docs" className="ch-footer-link">{tNav("docs")}</a>
          <a href="/campaigns" className="ch-footer-link">{tNav("campaigns")}</a>
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

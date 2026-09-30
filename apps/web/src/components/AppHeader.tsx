/**
 * AppHeader — top nav bar.
 * Cherry wordmark image linking home, nav links, login button.
 * Mobile (<768px): nav collapses into a Sheet side-panel.
 * ThemeToggle is NOT in the header (it's in the footer per spec).
 */
"use client";
import { Link } from "@/i18n/routing";
import { useTranslations } from "next-intl";
import Image from "next/image";
import * as React from "react";
import {
  Button,
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetTitle,
  SheetClose,
} from "@cherrio/ui";

const NAV_LINKS = [
  { href: "/campaigns", key: "campaigns" },
  { href: "/charity-market-cap", key: "charityMarketCap" },
  { href: "/emergency-pool", key: "emergencyPool" },
  { href: "#how-it-works", key: "howItWorks" },
] as const;

export function AppHeader() {
  const t = useTranslations("ui.nav");
  const [open, setOpen] = React.useState(false);

  return (
    <header className="ch-header">
      {/* Wordmark — ink on light, white on dark (pure CSS swap, no JS flash) */}
      <Link href="/" className="ch-header-wordmark">
        <Image
          src="/brand/cherrio-wordmark-ink.svg"
          alt={t("logoAlt")}
          width={140}
          height={40}
          priority
          className="ch-header-wordmark-ink"
        />
        <Image
          src="/brand/cherrio-wordmark-white.svg"
          alt={t("logoAlt")}
          width={140}
          height={40}
          priority
          className="ch-header-wordmark-light"
        />
      </Link>

      {/* Desktop nav */}
      <nav className="ch-header-nav" aria-label={t("mainNav")}>
        {NAV_LINKS.map(({ href, key }) => (
          <Link key={key} href={href} className="ch-btn ch-btn-ghost ch-header-link">
            {t(key)}
          </Link>
        ))}
        <Button variant="ghost" className="ch-header-link">
          {t("login")}
        </Button>
      </nav>

      {/* Mobile hamburger */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <button
            type="button"
            className="ch-btn ch-btn-ghost ch-header-burger"
            aria-label={t("openMobileMenu")}
          >
            <span aria-hidden="true">☰</span>
          </button>
        </SheetTrigger>
        <SheetContent side="right" aria-describedby={undefined}>
          <SheetTitle className="ch-sr-only">{t("mobileMenu")}</SheetTitle>
          <nav className="ch-sheet-nav" aria-label={t("mainNav")}>
            {NAV_LINKS.map(({ href, key }) => (
              <SheetClose key={key} asChild>
                <Link href={href} className="ch-btn ch-btn-ghost ch-sheet-link">
                  {t(key)}
                </Link>
              </SheetClose>
            ))}
            <SheetClose asChild>
              <Button variant="ghost" className="ch-sheet-link">
                {t("login")}
              </Button>
            </SheetClose>
          </nav>
        </SheetContent>
      </Sheet>
    </header>
  );
}

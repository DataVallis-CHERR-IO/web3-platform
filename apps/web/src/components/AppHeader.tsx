/**
 * AppHeader — top nav bar.
 * Cherry wordmark image linking home, nav links, login button.
 * Mobile (<768px): nav collapses into a Sheet side-panel.
 * ThemeToggle is NOT in the header (it's in the footer per spec).
 */
"use client";
import { Link, usePathname } from "@/i18n/routing";
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
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@cherrio/ui";
import { useAppAuth } from "./auth/PrivyClientProvider";
import { CurrencySelect } from "./CurrencySelect";

const NAV_LINKS = [
  { href: "/campaigns", key: "campaigns" },
  { href: "/charity-market-cap", key: "charityMarketCap" },
  { href: "/emergency-pool", key: "emergencyPool" },
  { href: "#how-it-works", key: "howItWorks" },
] as const;

function shortenHex(hex: string): string {
  if (hex.length <= 10) return hex;
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

export function AppHeader() {
  const t = useTranslations("ui.nav");
  const [open, setOpen] = React.useState(false);
  const pathname = usePathname();
  // The nav item of the current section (ADR-041): cherry text with a cherry underline.
  const current = (href: string) =>
    !href.startsWith("#") && (pathname === href || pathname.startsWith(`${href}/`)) ? ("page" as const) : undefined;
  const { isAvailable, isAuthenticated, isLoading, user, login, logout } =
    useAppAuth();

  const accountLabel = React.useMemo(() => {
    if (!user) return t("account");
    if (user.displayName) return user.displayName;
    const addresses = user.addresses ?? [];
    const primary = addresses.find((a) => a.isPrimary) ?? addresses[0];
    if (primary) return shortenHex(primary.address);
    return t("account");
  }, [user, t]);

  // Menu entries for a logged-in user; "Admin" only for a platform admin (roles from the DB session).
  const accountLinks = [
    { href: "/account", key: "myAccount" },
    { href: "/account/organization", key: "myOrganisation" },
    { href: "/account/campaigns", key: "myCampaigns" },
    ...(user?.roles?.includes("PLATFORM_ADMIN") ? [{ href: "/admin", key: "admin" }] : []),
  ] as const;

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
          <Link key={key} href={href} className="ch-btn ch-btn-ghost ch-header-link" aria-current={current(href)}>
            {t(key)}
          </Link>
        ))}

        <CurrencySelect />

        {isAuthenticated && user ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="ch-header-link font-mono">
                {accountLabel}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {accountLinks.map(({ href, key }) => (
                <DropdownMenuItem key={key} asChild>
                  <Link href={href} className="w-full">
                    {t(key)}
                  </Link>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => logout()}>
                {t("logout")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button
            variant="ghost"
            className="ch-header-link"
            disabled={!isAvailable || isLoading}
            title={!isAvailable ? t("authUnavailable") : undefined}
            onClick={login}
          >
            {t("login")}
          </Button>
        )}
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
            <CurrencySelect className="px-2 pb-2" onChosen={() => setOpen(false)} />
            {NAV_LINKS.map(({ href, key }) => (
              <SheetClose key={key} asChild>
                <Link href={href} className="ch-btn ch-btn-ghost ch-sheet-link" aria-current={current(href)}>
                  {t(key)}
                </Link>
              </SheetClose>
            ))}

            {isAuthenticated && user ? (
              <>
                {accountLinks.map(({ href, key }) => (
                  <SheetClose key={key} asChild>
                    <Link href={href} className="ch-btn ch-btn-ghost ch-sheet-link">
                      {key === "myAccount" ? `${t(key)} (${accountLabel})` : t(key)}
                    </Link>
                  </SheetClose>
                ))}
                <SheetClose asChild>
                  <Button
                    variant="ghost"
                    className="ch-sheet-link"
                    onClick={() => logout()}
                  >
                    {t("logout")}
                  </Button>
                </SheetClose>
              </>
            ) : (
              <SheetClose asChild>
                <Button
                  variant="ghost"
                  className="ch-sheet-link"
                  disabled={!isAvailable || isLoading}
                  title={!isAvailable ? t("authUnavailable") : undefined}
                  onClick={login}
                >
                  {t("login")}
                </Button>
              </SheetClose>
            )}
          </nav>
        </SheetContent>
      </Sheet>
    </header>
  );
}

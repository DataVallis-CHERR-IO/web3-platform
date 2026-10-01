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
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@cherrio/ui";
import { useAppAuth } from "./auth/PrivyClientProvider";

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
  const { isAvailable, isAuthenticated, isLoading, user, login, logout } =
    useAppAuth();

  const accountLabel = React.useMemo(() => {
    if (!user) return t("account");
    if (user.displayName) return user.displayName;
    const primary = user.addresses.find((a) => a.isPrimary) ?? user.addresses[0];
    if (primary) return shortenHex(primary.address);
    return t("account");
  }, [user, t]);

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

        {isAuthenticated && user ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="ch-header-link font-mono">
                {accountLabel}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href="/account" className="w-full">
                  {t("myAccount")}
                </Link>
              </DropdownMenuItem>
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
            {NAV_LINKS.map(({ href, key }) => (
              <SheetClose key={key} asChild>
                <Link href={href} className="ch-btn ch-btn-ghost ch-sheet-link">
                  {t(key)}
                </Link>
              </SheetClose>
            ))}

            {isAuthenticated && user ? (
              <>
                <SheetClose asChild>
                  <Link href="/account" className="ch-btn ch-btn-ghost ch-sheet-link">
                    {t("myAccount")} ({accountLabel})
                  </Link>
                </SheetClose>
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

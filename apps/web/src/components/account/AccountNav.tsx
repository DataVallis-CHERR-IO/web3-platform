"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/routing";
import { useAppAuth } from "@/components/auth/PrivyClientProvider";

// Side menu of the account area (TASK-058, David 2026-10-08: "menu nekje ob
// strani"). Desktop: a sticky column with the user's level on top. Phones: a
// row of tabs that scrolls sideways under the header. The header's account
// dropdown stays for reaching the area from public pages.

export interface AccountNavProps {
  /** Name or short address shown on top. */
  label: string;
  /** Proof of Charity level (ADR-057): "Level 2 · Giver"; null = no level yet. */
  levelText: string;
  isAdmin: boolean;
}

const LINKS = [
  { href: "/account", key: "myAccount" },
  { href: "/account/impact", key: "myImpact" },
  { href: "/account/donations", key: "myDonations" },
  { href: "/account/notifications", key: "notifications" },
  { href: "/account/organization", key: "myOrganisation" },
  { href: "/account/campaigns", key: "myCampaigns" },
] as const;

export function AccountNav({ label, levelText, isAdmin }: AccountNavProps) {
  const t = useTranslations("ui.nav");
  const pathname = usePathname();
  const { isAuthenticated, logout } = useAppAuth();
  const [votesWaiting, setVotesWaiting] = React.useState(0);
  const navRef = React.useRef<HTMLUListElement>(null);

  // Phones: bring the current tab into view in the sideways row.
  React.useEffect(() => {
    const el = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (el && navRef.current && navRef.current.scrollWidth > navRef.current.clientWidth) {
      navRef.current.scrollLeft = el.offsetLeft - (navRef.current.clientWidth - el.offsetWidth) / 2;
    }
  }, [pathname]);

  React.useEffect(() => {
    let alive = true;
    fetch("/api/me/donations", { cache: "no-store" })
      // Always read the body (an unread one keeps the request open).
      .then((r) => (r.ok ? (r.json() as Promise<{ votesWaiting: number }>) : r.text().then(() => null)))
      .then((j) => { if (alive && j) setVotesWaiting(j.votesWaiting); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [pathname]);

  // "/account" is current only on itself; the others also for their sub-pages.
  const current = (href: string) =>
    (href === "/account" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`)) ? ("page" as const) : undefined;

  return (
    <aside className="ch-account-side">
      <div className="ch-account-who">
        <span className="ch-account-who-name">{label}</span>
        <Link href="/account/impact" className="ch-account-level">{levelText}</Link>
      </div>
      <nav aria-label={t("accountNav")}>
        <ul className="ch-account-nav" ref={navRef}>
          {LINKS.map(({ href, key }) => (
            <li key={key}>
              <Link href={href} className="ch-account-link" aria-current={current(href)}>
                <span>{t(key)}</span>
                {key === "myDonations" && votesWaiting > 0 && (
                  <span className="ch-account-badge">
                    <span aria-hidden="true">{votesWaiting}</span>
                    <span className="ch-sr-only">{t("votesWaiting", { count: votesWaiting })}</span>
                  </span>
                )}
              </Link>
            </li>
          ))}
          {isAdmin && (
            <li className="ch-account-nav-sep">
              <Link href="/admin" className="ch-account-link">{t("admin")}</Link>
            </li>
          )}
        </ul>
      </nav>
      {isAuthenticated && (
        <button type="button" className="ch-account-logout" onClick={() => logout()}>
          {t("logout")}
        </button>
      )}
    </aside>
  );
}

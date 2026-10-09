"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/routing";

// Menu of the admin area (TASK-021): one place to reach every admin page, built
// from the account area's menu (TASK-058) but shown as a tab row on top at every
// width, so wide admin tables keep the full width (it wraps on desktops and
// scrolls sideways up to 1024 px). Rendered by the admin layout only
// after the role and second-factor checks passed.

const LINKS = [
  { href: "/admin", key: "overview" },
  { href: "/admin/kyb", key: "kyb" },
  { href: "/admin/campaigns", key: "campaigns" },
  { href: "/admin/organizations", key: "organizations" },
  { href: "/admin/guardian", key: "chainActions" },
  { href: "/admin/emergency-pool", key: "pool" },
  { href: "/admin/contracts", key: "contracts" },
  { href: "/admin/audit", key: "audit" },
  { href: "/admin/demo", key: "demo" },
] as const;

export interface AdminNavProps {
  /** Demo campaigns are allowed on local/dev only. */
  showDemo: boolean;
}

export function AdminNav({ showDemo }: AdminNavProps) {
  const t = useTranslations("admin.nav");
  const pathname = usePathname();
  const navRef = React.useRef<HTMLUListElement>(null);

  // Phones: bring the current tab into view in the sideways row.
  React.useEffect(() => {
    const el = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (el && navRef.current && navRef.current.scrollWidth > navRef.current.clientWidth) {
      navRef.current.scrollLeft = el.offsetLeft - (navRef.current.clientWidth - el.offsetWidth) / 2;
    }
  }, [pathname]);

  // "/admin" is current only on itself; the others also for their detail pages.
  const current = (href: string) =>
    (href === "/admin" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`)) ? ("page" as const) : undefined;

  return (
    <aside className="ch-account-side">
      <nav aria-label={t("label")}>
        <ul className="ch-account-nav" ref={navRef}>
          {LINKS.filter((l) => showDemo || l.key !== "demo").map(({ href, key }) => (
            <li key={key}>
              <Link href={href} className="ch-account-link" aria-current={current(href)}>
                <span>{t(key)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}

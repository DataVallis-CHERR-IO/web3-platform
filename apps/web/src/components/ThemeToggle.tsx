/**
 * ThemeToggle — 3-state: light / dark / system.
 * Writes "theme" cookie; mutates data-theme on <html> immediately (no flash).
 * Server reads the cookie in layout.tsx and sets data-theme on SSR.
 */
"use client";
import * as React from "react";
import { useTranslations } from "next-intl";

type Theme = "light" | "dark" | "system";

const ICON: Record<Theme, string> = {
  light: "☀",
  dark: "☽",
  system: "◑",
};

export function ThemeToggle() {
  const t = useTranslations("ui.theme");
  const [theme, setTheme] = React.useState<Theme>("system");

  React.useEffect(() => {
    const stored = document.cookie.match(/(?:^|; )theme=([^;]*)/)?.[1] as Theme | undefined;
    if (stored === "light" || stored === "dark" || stored === "system") {
      setTheme(stored);
    }
  }, []);

  function cycle() {
    const next: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
    const newTheme = next[theme];
    setTheme(newTheme);
    document.cookie = `theme=${newTheme};path=/;max-age=31536000;samesite=lax`;

    const root = document.documentElement;
    if (newTheme === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", newTheme);
    }
  }

  return (
    <button
      type="button"
      onClick={cycle}
      className="ch-btn ch-btn-ghost"
      aria-label={t(theme)}
      title={t(theme)}
      style={{ padding: "0 12px", fontSize: 18, minWidth: 44, height: 44 }}
    >
      <span aria-hidden="true">{ICON[theme]}</span>
    </button>
  );
}

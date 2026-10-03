"use client";
import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  DISPLAY_CURRENCIES,
  DISPLAY_CURRENCY_COOKIE,
  currencyForLanguages,
  isDisplayCurrency,
} from "@cherrio/shared";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@cherrio/ui";
import { useRouter } from "@/i18n/routing";

function readCookie(): string | undefined {
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${DISPLAY_CURRENCY_COOKIE}=([^;]+)`));
  return match?.[1];
}

/**
 * The visitor's display currency (ADR-040): fiat or crypto. Amounts are
 * converted for display only; the choice is kept in a cookie (and the profile
 * when logged in). Before a choice, the browser's languages decide.
 */
export function CurrencySelect({ className, onChosen }: { className?: string; onChosen?: () => void }) {
  const t = useTranslations("fx");
  const locale = useLocale();
  const router = useRouter();
  const id = React.useId();
  const [currency, setCurrency] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  // After mount only: the cookie and navigator.languages do not exist on the server.
  React.useEffect(() => {
    const chosen = readCookie();
    setCurrency(isDisplayCurrency(chosen) ? chosen : currencyForLanguages(navigator.languages ?? [navigator.language]));
  }, []);

  const names = React.useMemo(() => {
    const display = new Intl.DisplayNames([locale], { type: "currency" });
    return (code: string) => {
      if (t.has(`crypto.${code}` as never)) return t(`crypto.${code}` as never);
      return display.of(code) ?? code;
    };
  }, [locale, t]);

  async function choose(next: string) {
    const previous = currency;
    setCurrency(next);
    setSaving(true);
    try {
      const res = await fetch("/api/preferences/currency", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currency: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onChosen?.();
      router.refresh();
    } catch {
      setCurrency(previous);
    } finally {
      setSaving(false);
    }
  }

  const group = (kind: "fiat" | "crypto") =>
    DISPLAY_CURRENCIES.filter((c) => c.kind === kind).map((c) => (
      <SelectItem key={c.code} value={c.code}>
        <span className="font-mono">{c.code}</span> · {names(c.code)}
      </SelectItem>
    ));

  return (
    <div className={className}>
      <span id={`${id}-label`} className="ch-sr-only">
        {t("label")}
      </span>
      <Select value={currency ?? undefined} onValueChange={(value) => void choose(value)} disabled={saving || currency === null}>
        <SelectTrigger aria-labelledby={`${id}-label`} className="w-auto min-w-[5.5rem] font-mono" title={t("label")}>
          <SelectValue placeholder={t("label")}>{currency}</SelectValue>
        </SelectTrigger>
        <SelectContent className="max-h-80 overflow-y-auto">
          <SelectGroup>
            <SelectLabel>{t("fiat")}</SelectLabel>
            {group("fiat")}
          </SelectGroup>
          <SelectSeparator />
          <SelectGroup>
            <SelectLabel>{t("cryptoGroup")}</SelectLabel>
            {group("crypto")}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}
